import { query } from '../db/pool.js'
import * as serp from './serpapi.js'
import * as parity from './parity.js'
import * as budget from '../lib/budget.js'
import { getSettings } from './settings.js'
import { notifyScan } from './notifier.js'
import { ensureAutoTargets } from '../jobs/autoTargets.js'

let running = false

export function isRunning () {
  return running
}

async function loadChannels () {
  const { rows } = await query('SELECT * FROM channels WHERE active ORDER BY sort_order')
  return rows
}

async function loadTargets () {
  const { rows } = await query(
    `SELECT t.*, p.name AS property_name, p.serp_query, p.serp_property_token,
            p.currency, p.id AS property_id
     FROM scan_targets t
     JOIN properties p ON p.id = t.property_id
     WHERE t.active AND p.active
     ORDER BY p.id, COALESCE(t.check_in, CURRENT_DATE + t.horizon_days)`
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
async function expirePastTargets () {
  const { rows } = await query(
    `UPDATE scan_targets SET active = FALSE
     WHERE active AND mode = 'fixed' AND check_in < CURRENT_DATE
     RETURNING label`
  )
  if (rows.length > 0) {
    console.log(`[scan] ${rows.length} alvo(s) de data fixa expiraram: ${rows.map((r) => r.label).join(', ')}`)
  }
  return rows.map((r) => r.label)
}

/** Garante o property_token em cache; custa 1 requisicao apenas na primeira vez. */
async function ensureToken (target, dates, opts) {
  if (target.serp_property_token) return { token: target.serp_property_token, spent: 0 }

  const found = await serp.findPropertyToken(target.serp_query, {
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults: target.adults
  }, opts)

  await query('UPDATE properties SET serp_property_token = $1 WHERE id = $2', [
    found.token,
    target.property_id
  ])
  return { token: found.token, spent: 1 }
}

async function processTarget (scanId, target, channels, settings, opts) {
  const dates = resolveDates(target)
  const los = dates.los
  let spent = 0

  const { token, spent: tokenSpent } = await ensureToken(target, dates, opts)
  spent += tokenSpent

  const { offers } = await serp.fetchOffers(token, target.serp_query, {
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults: target.adults,
    los
  }, opts)
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
                          los, adults, price, currency, source_raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [scanId, target.property_id, o.channel.id, target.id, dates.checkIn, dates.checkOut,
        los, target.adults, o.price, target.currency, o.sourceRaw]
    )
  }

  const found = parity.evaluate(observations, settings)
  for (const f of found) {
    await query(
      `INSERT INTO findings (scan_id, property_id, channel_id, target_id, check_in, check_out,
                             kind, base_price, channel_price, delta_abs, delta_pct, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [scanId, target.property_id, f.channelId ?? null, target.id, dates.checkIn, dates.checkOut,
        f.kind, f.basePrice, f.channelPrice, f.deltaAbs, f.deltaPct, f.severity]
    )
  }

  // Canal monitorado que sumiu da oferta: possivel bloqueio ou ruptura de estoque.
  const seenIds = new Set(observations.map((o) => o.channel.id))
  const missing = channels.filter((c) => c.kind === 'ota' && !seenIds.has(c.id))
  for (const c of missing) {
    await query(
      `INSERT INTO findings (scan_id, property_id, channel_id, target_id, check_in, check_out,
                             kind, severity)
       VALUES ($1,$2,$3,$4,$5,$6,'missing_channel','info')`,
      [scanId, target.property_id, c.id, target.id, dates.checkIn, dates.checkOut]
    )
  }

  return { spent, rates: observations.length, findings: found.length, unmatched }
}

/**
 * Executa uma varredura completa.
 * @param {'schedule'|'manual'} trigger
 */
export async function runScan ({ trigger = 'schedule' } = {}) {
  if (running) {
    return { skipped: true, reason: 'Uma varredura ja esta em andamento' }
  }
  running = true

  const settings = await getSettings()
  const channels = await loadChannels()
  // Antes de contar alvos: retira os de data fixa que ja passaram, senao eles
  // entrariam no orcamento desta varredura.
  const expired = await expirePastTargets().catch(() => [])
  // Gera os periodos da semana (fim de semana e meio de semana). So age as
  // tercas, ou no primeiro boot, para o sistema ja subir com dados.
  const auto = await ensureAutoTargets().catch(() => ({ generated: [] }))
  const targets = await loadTargets()
  // Disparo manual pode usar a reserva de emergencia; o agendador nunca pode.
  const opts = { allowReserve: trigger === 'manual' }

  const { rows: scanRows } = await query(
    'INSERT INTO scans (trigger, targets_total) VALUES ($1, $2) RETURNING id',
    [trigger, targets.length]
  )
  const scanId = scanRows[0].id

  let spent = 0
  let ok = 0
  let rates = 0
  let findings = 0
  const errors = []
  // Anunciantes que apareceram mas nao correspondem a nenhum canal cadastrado.
  // Ficam registrados porque um deles pode estar furando a paridade sem que
  // ninguem esteja olhando.
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
        `UPDATE scans SET status='skipped', finished_at=now(),
                          message=$2 WHERE id=$1`,
        [scanId, `Orcamento SerpAPI esgotado (${usage.used}/${usage.limit})`]
      )
      return { scanId, skipped: true, reason: 'budget', usage }
    }

    for (const target of targets) {
      try {
        const r = await processTarget(scanId, target, channels, settings, opts)
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

    const notification = await notifyScan(scanId).catch((err) => ({
      sent: false,
      error: err.message
    }))

    return { scanId, status, spent, ok, rates, findings, errors, notification }
  } catch (err) {
    await query(
      `UPDATE scans SET status='failed', finished_at=now(), requests_used=$3, message=$2
       WHERE id=$1`,
      [scanId, err.message, spent]
    )
    throw err
  } finally {
    running = false
  }
}
