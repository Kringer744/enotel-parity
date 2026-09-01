import { query } from '../db/pool.js'
import { getSettings } from './settings.js'
import * as uazapi from './uazapi.js'
import { atLeast } from './parity.js'
import { getUsage } from '../lib/budget.js'

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
// O WhatsApp nao renderiza icones vetoriais: a severidade vai como rotulo de
// texto em caixa alta, que le bem em qualquer aparelho e em notificacao.
const SEV_LABEL = { critical: 'CRITICO', serious: 'GRAVE', warning: 'ATENCAO', info: 'INFO' }

function fmtDate (d) {
  const date = d instanceof Date ? d : new Date(`${d}T12:00:00Z`)
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
}

/**
 * Monta a mensagem de alerta. Formatacao WhatsApp: *negrito*, _italico_.
 * O objetivo e caber numa notificacao de celular: violacao mais grave primeiro,
 * numeros absolutos e percentuais, sem jargao.
 */
export function buildMessage ({ scan, findings, usage, propertyName }) {
  const lines = []
  const when = new Date(scan.started_at).toLocaleString('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Recife'
  })

  if (findings.length === 0) {
    lines.push('*PARIDADE OK — Enotel BR*')
    lines.push('')
    lines.push(`${propertyName}`)
    lines.push(`Varredura de ${when}`)
    lines.push('')
    lines.push('Nenhuma violacao de paridade encontrada nos canais monitorados.')
    lines.push('')
    lines.push(`_SerpAPI: ${usage.used}/${usage.limit} requisicoes usadas no mes_`)
    return lines.join('\n')
  }

  const worst = findings[0]
  lines.push(`*ALERTA DE PARIDADE — Enotel BR* [${SEV_LABEL[worst.severity]}]`)
  lines.push('')
  lines.push(`*${propertyName}*`)
  lines.push(`Varredura de ${when}`)
  lines.push(`*${findings.length}* ${findings.length === 1 ? 'violacao encontrada' : 'violacoes encontradas'}`)
  lines.push('')

  for (const f of findings.slice(0, 8)) {
    if (f.kind === 'missing_direct') {
      lines.push(`*[${SEV_LABEL[f.severity]}] Site oficial ausente* — ${fmtDate(f.check_in)}`)
      lines.push('   Sem tarifa direta publicada para comparacao.')
      lines.push('')
      continue
    }

    const sign = f.delta_pct < 0 ? '' : '+'
    lines.push(`*[${SEV_LABEL[f.severity]}] ${f.channel_name}*`)
    lines.push(`   Check-in ${fmtDate(f.check_in)} · ${f.los || 2} noites`)
    lines.push(`   Direto: ${BRL.format(f.base_price)}  →  Canal: ${BRL.format(f.channel_price)}`)
    lines.push(`   Diferenca: ${sign}${Number(f.delta_pct).toFixed(1)}% (${BRL.format(Math.abs(f.delta_abs))}/noite)`)
    lines.push('')
  }

  if (findings.length > 8) {
    lines.push(`_... e mais ${findings.length - 8} violacao(oes). Veja o relatorio completo no painel._`)
    lines.push('')
  }

  lines.push(`_SerpAPI: ${usage.used}/${usage.limit} requisicoes usadas no mes_`)
  return lines.join('\n')
}

async function findingsForScan (scanId, minSeverity) {
  const { rows } = await query(
    `SELECT f.*, c.name AS channel_name, c.slug AS channel_slug, t.los
     FROM findings f
     LEFT JOIN channels c ON c.id = f.channel_id
     LEFT JOIN scan_targets t ON t.id = f.target_id
     WHERE f.scan_id = $1
       AND f.kind IN ('undercut', 'overcut', 'missing_direct')
     ORDER BY
       CASE f.severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1
                       WHEN 'warning' THEN 2 ELSE 3 END,
       f.delta_pct ASC`,
    [scanId]
  )
  return rows.filter((f) => atLeast(f.severity, minSeverity))
}

/** Dispara os alertas de uma varredura para todos os destinatarios ativos. */
export async function notifyScan (scanId) {
  const settings = await getSettings()
  const notif = settings.notifications

  if (!notif.enabled) return { sent: false, reason: 'notificacoes desativadas' }
  if (!uazapi.isConfigured()) return { sent: false, reason: 'uazapi nao configurada' }

  const { rows: recipients } = await query(
    'SELECT * FROM whatsapp_recipients WHERE active ORDER BY id'
  )
  if (recipients.length === 0) {
    return { sent: false, reason: 'nenhum destinatario selecionado' }
  }

  const findings = await findingsForScan(scanId, notif.min_severity)
  if (findings.length === 0 && notif.silent_when_clean) {
    return { sent: false, reason: 'sem violacoes (modo silencioso)' }
  }

  const { rows: scanRows } = await query('SELECT * FROM scans WHERE id = $1', [scanId])
  const scan = scanRows[0]
  const { rows: propRows } = await query(
    'SELECT name FROM properties WHERE active ORDER BY id LIMIT 1'
  )
  const usage = await getUsage()

  const body = buildMessage({
    scan,
    findings,
    usage,
    propertyName: propRows[0]?.name || 'Enotel'
  })

  const results = []
  for (const r of recipients) {
    const target = r.jid || r.phone
    const { rows: nRows } = await query(
      `INSERT INTO notifications (scan_id, recipient_id, phone, body)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [scanId, r.id, r.phone, body]
    )
    const notificationId = nRows[0].id

    try {
      await uazapi.sendText(target, body)
      await query(
        "UPDATE notifications SET status='sent', sent_at=now() WHERE id=$1",
        [notificationId]
      )
      results.push({ recipient: r.name, ok: true })
    } catch (err) {
      await query(
        "UPDATE notifications SET status='failed', error=$2 WHERE id=$1",
        [notificationId, err.message]
      )
      results.push({ recipient: r.name, ok: false, error: err.message })
    }
  }

  await query('UPDATE findings SET notified_at = now() WHERE scan_id = $1', [scanId])

  return {
    sent: results.some((r) => r.ok),
    findings: findings.length,
    results
  }
}

/** Envio de teste, para validar a conexao sem esperar a proxima varredura. */
export async function sendTest (to) {
  const text = [
    '*TESTE — Enotel Paridade*',
    '',
    'Se voce recebeu esta mensagem, a integracao com o WhatsApp esta funcionando.',
    'Os alertas de paridade chegarao neste contato.'
  ].join('\n')
  await uazapi.sendText(to, text)
  return { ok: true }
}
