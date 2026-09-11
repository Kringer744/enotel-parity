import { query } from '../db/pool.js'
import * as serp from './serpapi.js' // ainda usado por resolveDates (datesForHorizon)
import { config } from '../config.js'
import { connectorForVertical } from './connectors/index.js'
import * as parity from './parity.js'
import * as budget from '../lib/budget.js'
import { getSettings } from './settings.js'
import { notifyScan } from './notifier.js'
import { ensureAutoTargets } from '../jobs/autoTargets.js'

let running = false

export function isRunning () {
  return running
}

async function loadChannels (tenantId) {
  const { rows } = await query(
    'SELECT * FROM channels WHERE tenant_id = $1 AND active ORDER BY sort_order',
    [tenantId]
  )
  return rows
}

async function loadTargets (tenantId) {
  const { rows } = await query(
    `SELECT t.*, s.name AS property_name, s.serp_query, s.serp_property_token,
            s.currency, s.vertical, s.id AS property_id
     FROM targets t
     JOIN subjects s ON s.id = t.property_id
     WHERE t.active AND s.active AND t.tenant_id = $1
     ORDER BY s.id, COALESCE(t.check_in, CURRENT_DATE + t.horizon_days)`,
    [tenantId]
  )
  return rows
}

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))

/**
 * Resolve as datas do alvo conforme o modo. No modo 'fixed' o numero de noites
 * vem da propria diferenca entre as datas -- nao da coluna los, que so descreve
 * a janela movel.
 */
function resolveDates (target) {
  if (target.mode === 'fixed') {
    const checkIn = iso(target.check_in)
    const checkOut = iso(target.check_out)
    const nights = Math.max(
      1,
      Math.round((new Date(`${checkOut}T12:00:00Z`) - new Date(`${checkIn}T12:00:00Z`)) / 86400000)
    )
    return { checkIn, checkOut, los: nights }
  }
  return { ...serp.datesForHorizon(target.horizon_days, target.los), los: target.los }
}

/**
 * Alvos de data fixa viram lixo depois que o check-in passa: continuariam
 * gastando requisicoes para consultar uma estadia que ja aconteceu.
 */
async function expirePastTargets (tenantId) {
  const { rows } = await query(
    `UPDATE targets SET active = FALSE
     WHERE active AND mode = 'fixed' AND check_in < CURRENT_DATE AND tenant_id = $1
     RETURNING label`,
    [tenantId]
  )
  if (rows.length > 0) {
    console.log(`[scan] ${rows.length} alvo(s) de data fixa expiraram: ${rows.map((r) => r.label).join(', ')}`)
  }
  return rows.map((r) => r.label)
}

/**
 * Monta o ctx injetado no conector. F1: credenciais do config + guarda de orcamento
 * global (respeita o teto SerpAPI de 250/mes via budget.consume dentro do conector).
 * §11.4: troca por credenciais/limite de tenant_connectors -- sem tocar no conector.
 */
function buildCtx (target, opts) {
  return {
    credentials: { apiKey: config.serpapi.key, endpoint: config.serpapi.endpoint },
    budget,
    currency: target.currency || 'BRL',
    allowReserve: Boolean(opts?.allowReserve)
  }
}

/**
 * Garante o handle (property_token) em cache; custa 1 requisicao apenas na primeira
 * vez. `discover` NAO persiste -- a gravacao do handle no subject e feita aqui.
 */
async function ensureToken (tenantId, target, dates, opts) {
  if (target.serp_property_token) return { token: target.serp_property_token, spent: 0 }

  const connector = connectorForVertical(target.vertical || 'hotel')
  const { handle } = await connector.discover(target, buildCtx(target, opts))

  await query('UPDATE subjects SET serp_property_token = $1 WHERE id = $2 AND tenant_id = $3', [
    handle,
    target.property_id,
    tenantId
  ])
  return { token: handle, spent: 1 }
}

async function processTarget (tenantId, scanId, target, channels, settings, opts) {
  const dates = resolveDates(target)
  const los = dates.los
  let spent = 0

  const connector = connectorForVertical(target.vertical || 'hotel')

  const { token, spent: tokenSpent } = await ensureToken(tenantId, target, dates, opts)
  spent += tokenSpent

  // O conector resolve as datas internamente a partir do target e devolve Offer[]
  // ja normalizado (com currency). Passamos o handle recem-garantido. O budget e
  // consumido dentro do conector via ctx.budget (respeita o teto de 250/mes).
  const { offers } = await connector.fetchOffers({ ...target, serp_property_token: token }, buildCtx(target, opts))
  spent += 1

  // Mapeia ofertas -> canais monitorados. Ofertas de canais nao cadastrados
  // (agencias avulsas) sao descartadas de proposito: nao ha contrato de paridade.
  const directChannel = channels.find((c) => c.kind === 'direct')
  const observations = []
  const unmatched = []

  for (const offer of offers) {
    // A SerpAPI marca o site do proprio hotel com `official`. Esse sinal e mais
    // confiavel que o nome, que vem como "Enotel Convention & Spa Porto de
    // Galinhas" -- nao como "Enotel".
    const channel = (offer.official && directChannel)
      ? directChannel
      : parity.matchChannel(offer.source, channels)

    if (!channel) { unmatched.push(offer.source); continue }
    // Se o mesmo canal aparecer duas vezes, fica a menor tarifa -- e ela que o
    // hospede enxerga e ela que caracteriza a violacao.
    const existing = observations.find((o) => o.channel.id === channel.id)
    if (existing) {
      if (offer.price < existing.price) {
        existing.price = offer.price
        existing.sourceRaw = offer.source
      }
      continue
    }
    observations.push({ channel, price: offer.price, sourceRaw: offer.source })
  }

  for (const o of observations) {
    await query(
      `INSERT INTO rates (scan_id, property_id, channel_id, target_id, check_in, check_out,
                          los, adults, price, currency, source_raw, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [scanId, target.property_id, o.channel.id, target.id, dates.checkIn, dates.checkOut,
        los, target.adults, o.price, target.currency, o.sourceRaw, tenantId]
    )
  }

  const found = parity.evaluate(observations, settings)
  for (const f of found) {
    await query(
      `INSERT INTO findings (scan_id, property_id, channel_id, target_id, check_in, check_out,
                             kind, base_price, channel_price, delta_abs, delta_pct, severity, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [scanId, target.property_id, f.channelId ?? null, target.id, dates.checkIn, dates.checkOut,
        f.kind, f.basePrice, f.channelPrice, f.deltaAbs, f.deltaPct, f.severity, tenantId]
    )
  }

  // Canal monitorado que sumiu da oferta: possivel bloqueio ou ruptura de estoque.
  const seenIds = new Set(observations.map((o) => o.channel.id))
  const missing = channels.filter((c) => c.kind === 'ota' && !seenIds.has(c.id))
  for (const c of missing) {
    await query(
      `INSERT INTO findings (scan_id, property_id, channel_id, target_id, check_in, check_out,
                             kind, severity, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,'missing_channel','info',$7)`,
      [scanId, target.property_id, c.id, target.id, dates.checkIn, dates.checkOut, tenantId]
    )
  }

  return { spent, rates: observations.length, findings: found.length, unmatched }
}

/**
 * Executa a varredura de UM tenant. Escopa canais/alvos/gravacoes pelo tenant_id.
 * O orcamento (SerpAPI global) e a notificacao seguem globais na F1 -- o
 * orcamento por-tenant e a notificacao por-tenant sao o §11.4 (proxima peca).
 */
async function scanTenant (tenantId, { trigger = 'schedule' } = {}) {
  const settings = await getSettings(tenantId)
  const channels = await loadChannels(tenantId)
  // Antes de contar alvos: retira os de data fixa que ja passaram, senao eles
  // entrariam no orcamento desta varredura.
  const expired = await expirePastTargets(tenantId).catch(() => [])
  // Gera os periodos da semana (fim de semana e meio de semana). So age as
  // tercas, ou no primeiro boot, para o sistema ja subir com dados.
  const auto = await ensureAutoTargets({ tenantId }).catch(() => ({ generated: [] }))
  const targets = await loadTargets(tenantId)
  // Disparo manual pode usar a reserva de emergencia; o agendador nunca pode.
  const opts = { allowReserve: trigger === 'manual' }

  const { rows: scanRows } = await query(
    'INSERT INTO scans (trigger, targets_total, tenant_id) VALUES ($1, $2, $3) RETURNING id',
    [trigger, targets.length, tenantId]
  )
  const scanId = scanRows[0].id

  let spent = 0
  let ok = 0
  let rates = 0
  let findings = 0
  const errors = []
  // Anunciantes que apareceram mas nao correspondem a nenhum canal cadastrado.
  const unmatched = new Set()

  try {
    // Alinha o contador local ao consumo real da conta antes de decidir
    // qualquer coisa -- a chave pode ter sido usada fora deste sistema.
    await budget.syncWithProvider().catch(() => null)

    // Checagem previa: se nem o primeiro alvo cabe, aborta sem gastar nada.
    const usage = await budget.getUsage()
    const available = opts.allowReserve ? usage.remaining : usage.scheduledRemaining
    if (available < 1) {
      await query(
        `UPDATE scans SET status='skipped', finished_at=now(), message=$2 WHERE id=$1`,
        [scanId, `Orcamento SerpAPI esgotado (${usage.used}/${usage.limit})`]
      )
      return { scanId, tenantId, skipped: true, reason: 'budget', usage }
    }

    for (const target of targets) {
      try {
        const r = await processTarget(tenantId, scanId, target, channels, settings, opts)
        spent += r.spent
        rates += r.rates
        findings += r.findings
        for (const s of r.unmatched) unmatched.add(s)
        ok += 1
      } catch (err) {
        errors.push(`${target.property_name} / ${target.label}: ${err.message}`)
        // Orcamento estourou no meio: parar imediatamente e preservar o resto.
        if (err.budgetExhausted) break
      }
    }

    const status = errors.length === 0 ? 'ok' : (ok > 0 ? 'partial' : 'failed')
    const notes = [...errors]
    if (unmatched.size > 0) {
      notes.push(`Canais nao monitorados na oferta: ${[...unmatched].join(', ')}`)
    }
    if (expired.length > 0) {
      notes.push(`Alvos de data fixa expirados e desativados: ${expired.join(', ')}`)
    }
    if (auto.generated?.length > 0) {
      notes.push(`Periodos automaticos criados: ${auto.generated.join(', ')}`)
    }
    await query(
      `UPDATE scans SET status=$2, finished_at=now(), requests_used=$3, targets_ok=$4,
                        rates_captured=$5, findings_count=$6, message=$7
       WHERE id=$1`,
      [scanId, status, spent, ok, rates, findings, notes.join(' | ') || null]
    )

    const notification = await notifyScan(scanId, tenantId).catch((err) => ({
      sent: false,
      error: err.message
    }))

    return { scanId, tenantId, status, spent, ok, rates, findings, errors, notification }
  } catch (err) {
    await query(
      `UPDATE scans SET status='failed', finished_at=now(), requests_used=$3, message=$2 WHERE id=$1`,
      [scanId, err.message, spent]
    )
    throw err
  }
}

/**
 * Executa uma varredura completa. Sem `tenantId`, itera todos os tenants ativos
 * (agendador global). Com `tenantId`, escopa a UM tenant -- e o que o disparo
 * manual de um tenant_admin usa, para nao varrer (nem gastar orcamento com) os
 * outros tenants. A guarda `running` cobre o ciclo inteiro (1 replica -- o cron
 * nao pode duplicar).
 * @param {{trigger?: 'schedule'|'manual', tenantId?: number}} [opts]
 */
export async function runScan ({ trigger = 'schedule', tenantId = null } = {}) {
  if (running) {
    return { skipped: true, reason: 'Uma varredura ja esta em andamento' }
  }
  running = true

  try {
    const { rows: tenants } = Number.isInteger(tenantId)
      ? { rows: [{ id: tenantId }] }
      : await query('SELECT id FROM tenants WHERE active ORDER BY id')
    const runs = []
    for (const t of tenants) {
      try {
        runs.push(await scanTenant(t.id, { trigger }))
      } catch (err) {
        console.error(`[scan] tenant #${t.id} falhou:`, err.message)
        runs.push({ tenantId: t.id, status: 'failed', error: err.message })
      }
    }
    return { runs }
  } finally {
    running = false
  }
}
