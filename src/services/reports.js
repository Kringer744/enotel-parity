import { query } from '../db/pool.js'
import { forecast } from '../lib/budget.js'

/** KPIs do topo do painel. */
export async function overview () {
  const [lastScan, severity, coverage, budget, trendDelta] = await Promise.all([
    query(`SELECT * FROM scans ORDER BY started_at DESC LIMIT 1`),

    query(
      `SELECT severity, COUNT(*)::int AS count
       FROM findings
       WHERE status = 'open'
         AND kind IN ('undercut','overcut','missing_direct')
         AND created_at > now() - interval '7 days'
       GROUP BY severity`
    ),

    // Taxa de conformidade da ultima varredura: comparacoes limpas / total.
    query(
      `WITH last AS (SELECT id FROM scans WHERE status IN ('ok','partial') ORDER BY started_at DESC LIMIT 1)
       SELECT
         (SELECT COUNT(*)::int FROM rates r
            JOIN channels c ON c.id = r.channel_id
           WHERE r.scan_id = (SELECT id FROM last) AND c.kind = 'ota') AS comparisons,
         (SELECT COUNT(*)::int FROM findings f
           WHERE f.scan_id = (SELECT id FROM last) AND f.kind = 'undercut') AS violations`
    ),

    forecast(),

    // Maior desconto de OTA nos ultimos 7 dias -- o numero que dói.
    query(
      `SELECT f.delta_pct, f.delta_abs, f.base_price, f.channel_price, f.check_in,
              c.name AS channel_name
       FROM findings f JOIN channels c ON c.id = f.channel_id
       WHERE f.kind = 'undercut' AND f.created_at > now() - interval '7 days'
       ORDER BY f.delta_pct ASC LIMIT 1`
    )
  ])

  const sev = Object.fromEntries(severity.rows.map((r) => [r.severity, r.count]))
  const cov = coverage.rows[0] || { comparisons: 0, violations: 0 }
  const complianceRate = cov.comparisons > 0
    ? Math.round(((cov.comparisons - cov.violations) / cov.comparisons) * 1000) / 10
    : null

  return {
    lastScan: lastScan.rows[0] || null,
    openBySeverity: {
      critical: sev.critical || 0,
      serious: sev.serious || 0,
      warning: sev.warning || 0,
      info: sev.info || 0
    },
    openTotal: (sev.critical || 0) + (sev.serious || 0) + (sev.warning || 0),
    comparisons: cov.comparisons,
    violations: cov.violations,
    complianceRate,
    worstGap: trendDelta.rows[0] || null,
    budget
  }
}

/**
 * Serie temporal de tarifas por canal. Uma linha por canal, um ponto por dia.
 * Fixa um unico alvo (horizonte) para nao misturar niveis de preco diferentes.
 */
export async function priceTrend ({ days = 30, targetId = null } = {}) {
  const { rows: targets } = await query(
    `SELECT t.id, t.label FROM scan_targets t JOIN properties p ON p.id = t.property_id
     WHERE t.active AND p.active ORDER BY t.horizon_days LIMIT 1`
  )
  const target = targetId || targets[0]?.id
  if (!target) return { target: null, dates: [], series: [] }

  const { rows } = await query(
    `SELECT date_trunc('day', r.captured_at AT TIME ZONE 'America/Recife')::date AS day,
            c.slug, c.name, c.color, c.kind,
            ROUND(AVG(r.price)::numeric, 2) AS price
     FROM rates r
     JOIN channels c ON c.id = r.channel_id
     WHERE r.target_id = $1
       AND r.captured_at > now() - ($2 || ' days')::interval
     GROUP BY day, c.slug, c.name, c.color, c.kind, c.sort_order
     ORDER BY day, c.sort_order`,
    [target, String(days)]
  )

  const dates = [...new Set(rows.map((r) => r.day.toISOString().slice(0, 10)))].sort()
  const bySlug = new Map()
  for (const r of rows) {
    if (!bySlug.has(r.slug)) {
      bySlug.set(r.slug, { slug: r.slug, name: r.name, color: r.color, kind: r.kind, data: {} })
    }
    bySlug.get(r.slug).data[r.day.toISOString().slice(0, 10)] = Number(r.price)
  }

  const series = [...bySlug.values()].map((s) => ({
    ...s,
    // null preserva a lacuna no grafico em vez de ligar dois dias distantes
    values: dates.map((d) => (d in s.data ? s.data[d] : null))
  }))

  return {
    target: targets.find((t) => t.id === target) || null,
    dates,
    series
  }
}

/** Conformidade por canal no periodo: quantas comparacoes, quantas furaram. */
export async function channelCompliance ({ days = 30 } = {}) {
  const { rows } = await query(
    `WITH comparisons AS (
       SELECT r.channel_id, COUNT(*)::int AS total
       FROM rates r JOIN channels c ON c.id = r.channel_id
       WHERE c.kind = 'ota' AND r.captured_at > now() - ($1 || ' days')::interval
       GROUP BY r.channel_id
     ),
     viol AS (
       SELECT f.channel_id,
              COUNT(*)::int AS violations,
              ROUND(AVG(f.delta_pct)::numeric, 2) AS avg_delta,
              ROUND(MIN(f.delta_pct)::numeric, 2) AS worst_delta
       FROM findings f
       WHERE f.kind = 'undercut' AND f.created_at > now() - ($1 || ' days')::interval
       GROUP BY f.channel_id
     )
     SELECT c.slug, c.name, c.color,
            COALESCE(cp.total, 0) AS comparisons,
            COALESCE(v.violations, 0) AS violations,
            v.avg_delta, v.worst_delta
     FROM channels c
     LEFT JOIN comparisons cp ON cp.channel_id = c.id
     LEFT JOIN viol v ON v.channel_id = c.id
     WHERE c.kind = 'ota' AND c.active
     ORDER BY c.sort_order`,
    [String(days)]
  )

  return rows.map((r) => ({
    ...r,
    comparisons: Number(r.comparisons),
    violations: Number(r.violations),
    complianceRate: r.comparisons > 0
      ? Math.round(((r.comparisons - r.violations) / r.comparisons) * 1000) / 10
      : null
  }))
}

/** Violacoes por dia e por canal -- alimenta o heatmap do relatorio. */
export async function violationHeatmap ({ days = 30 } = {}) {
  const { rows } = await query(
    `SELECT date_trunc('day', f.created_at AT TIME ZONE 'America/Recife')::date AS day,
            c.slug, c.name,
            COUNT(*)::int AS violations,
            ROUND(MIN(f.delta_pct)::numeric, 2) AS worst_delta
     FROM findings f JOIN channels c ON c.id = f.channel_id
     WHERE f.kind = 'undercut' AND f.created_at > now() - ($1 || ' days')::interval
     GROUP BY day, c.slug, c.name, c.sort_order
     ORDER BY day, c.sort_order`,
    [String(days)]
  )
  return rows.map((r) => ({ ...r, day: r.day.toISOString().slice(0, 10) }))
}

export async function listFindings ({ days = 30, severity = null, channel = null, status = null, limit = 200 } = {}) {
  const clauses = [`f.created_at > now() - ($1 || ' days')::interval`]
  const params = [String(days)]

  if (severity) { params.push(severity); clauses.push(`f.severity = $${params.length}`) }
  if (channel) { params.push(channel); clauses.push(`c.slug = $${params.length}`) }
  if (status) { params.push(status); clauses.push(`f.status = $${params.length}`) }
  params.push(limit)

  const { rows } = await query(
    `SELECT f.*, c.name AS channel_name, c.slug AS channel_slug, c.color AS channel_color,
            p.name AS property_name, t.label AS target_label, t.los
     FROM findings f
     LEFT JOIN channels c ON c.id = f.channel_id
     LEFT JOIN properties p ON p.id = f.property_id
     LEFT JOIN scan_targets t ON t.id = f.target_id
     WHERE ${clauses.join(' AND ')}
       AND f.kind IN ('undercut','overcut','missing_direct')
     ORDER BY f.created_at DESC,
       CASE f.severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1
                       WHEN 'warning' THEN 2 ELSE 3 END
     LIMIT $${params.length}`,
    params
  )
  return rows
}

/** Snapshot mais recente: preco atual de cada canal por data-alvo. */
export async function currentRates () {
  const { rows } = await query(
    `WITH last AS (
       SELECT id FROM scans WHERE status IN ('ok','partial') ORDER BY started_at DESC LIMIT 1
     )
     SELECT r.check_in, r.check_out, r.los, r.price, r.currency,
            c.slug, c.name AS channel_name, c.color, c.kind,
            t.label AS target_label, t.horizon_days
     FROM rates r
     JOIN channels c ON c.id = r.channel_id
     LEFT JOIN scan_targets t ON t.id = r.target_id
     WHERE r.scan_id = (SELECT id FROM last)
     ORDER BY t.horizon_days, c.sort_order`
  )

  const groups = new Map()
  for (const r of rows) {
    const key = r.check_in.toISOString().slice(0, 10)
    if (!groups.has(key)) {
      groups.set(key, {
        checkIn: key,
        checkOut: r.check_out.toISOString().slice(0, 10),
        los: r.los,
        targetLabel: r.target_label,
        horizonDays: r.horizon_days,
        offers: []
      })
    }
    groups.get(key).offers.push({
      slug: r.slug,
      name: r.channel_name,
      color: r.color,
      kind: r.kind,
      price: Number(r.price)
    })
  }

  // Anexa o desvio de cada OTA contra a tarifa direta do mesmo bloco.
  const out = [...groups.values()].sort((a, b) => a.horizonDays - b.horizonDays)
  for (const g of out) {
    const direct = g.offers.find((o) => o.kind === 'direct')
    g.directPrice = direct ? direct.price : null
    for (const o of g.offers) {
      o.deltaPct = direct && o.kind === 'ota'
        ? Math.round(((o.price - direct.price) / direct.price) * 1000) / 10
        : null
    }
  }
  return out
}

export async function scanHistory ({ limit = 30 } = {}) {
  const { rows } = await query(
    `SELECT id, trigger, status, started_at, finished_at, requests_used,
            targets_total, targets_ok, rates_captured, findings_count, message
     FROM scans ORDER BY started_at DESC LIMIT $1`,
    [limit]
  )
  return rows
}

/** Pacote unico para a pagina de relatorio e para exportacao. */
export async function fullReport ({ days = 30 } = {}) {
  const [ov, trend, compliance, heatmap, findings, rates, history] = await Promise.all([
    overview(),
    priceTrend({ days }),
    channelCompliance({ days }),
    violationHeatmap({ days }),
    listFindings({ days, limit: 500 }),
    currentRates(),
    scanHistory({ limit: days })
  ])
  return {
    generatedAt: new Date().toISOString(),
    periodDays: days,
    overview: ov,
    trend,
    compliance,
    heatmap,
    findings,
    currentRates: rates,
    history
  }
}

export function findingsToCsv (findings) {
  const header = [
    'data_deteccao', 'propriedade', 'canal', 'tipo', 'check_in', 'check_out',
    'noites', 'preco_direto', 'preco_canal', 'diferenca_reais', 'diferenca_pct',
    'severidade', 'status'
  ]
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [header.join(';')]
  for (const f of findings) {
    lines.push([
      new Date(f.created_at).toISOString(),
      f.property_name, f.channel_name || '-', f.kind,
      f.check_in?.toISOString?.().slice(0, 10) ?? f.check_in,
      f.check_out?.toISOString?.().slice(0, 10) ?? f.check_out,
      f.los ?? '', f.base_price ?? '', f.channel_price ?? '',
      f.delta_abs ?? '', f.delta_pct ?? '', f.severity, f.status
    ].map(esc).join(';'))
  }
  // BOM para o Excel pt-BR abrir com acentuacao correta
  return '﻿' + lines.join('\r\n')
}
