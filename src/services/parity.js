/**
 * Motor de paridade.
 *
 * Ancora = tarifa do site oficial Enotel. Uma OTA vendendo ABAIXO da ancora e
 * violacao de paridade (undercut): o hospede que compraria direto migra para o
 * canal comissionado. Vender acima nao quebra contrato, mas mata conversao, e
 * por isso e reportado separadamente e so acima de um limite alto.
 */

/** Casa o campo "source" da SerpAPI com um canal cadastrado. */
export function matchChannel (source, channels) {
  const s = String(source || '').toLowerCase().trim()
  if (!s) return null

  let best = null
  let bestLen = 0
  for (const ch of channels) {
    for (const pattern of ch.patterns || []) {
      const p = String(pattern).toLowerCase().trim()
      if (!p || !s.includes(p)) continue
      // O padrao mais longo vence: 'azul viagens' ganha de 'azul', e
      // 'hoteis.com' nao e capturado por um padrao generico.
      if (p.length > bestLen) {
        best = ch
        bestLen = p.length
      }
    }
  }
  return best
}

function severityFor (deltaPct, thresholds) {
  const d = Math.abs(deltaPct)
  if (d >= thresholds.critical) return 'critical'
  if (d >= thresholds.serious) return 'serious'
  if (d >= thresholds.warning) return 'warning'
  return 'info'
}

/**
 * Avalia um bloco de tarifas da MESMA propriedade e MESMA data.
 * `observations`: [{ channel, price }] onde channel e a linha da tabela channels.
 */
export function evaluate (observations, settings) {
  const cfg = settings.parity
  const findings = []

  const direct = observations.find((o) => o.channel.kind === 'direct')
  const otas = observations.filter((o) => o.channel.kind === 'ota')

  // Sem tarifa direta nao existe ancora: nenhuma comparacao e valida. Reportar
  // isso importa mais que silenciar -- normalmente significa que o site oficial
  // saiu do Google Hotels ou esta sem disponibilidade.
  if (!direct) {
    if (otas.length > 0) {
      findings.push({
        channelSlug: null,
        kind: 'missing_direct',
        basePrice: null,
        channelPrice: null,
        deltaAbs: null,
        deltaPct: null,
        severity: 'warning'
      })
    }
    return findings
  }

  const base = Number(direct.price)

  for (const o of otas) {
    const price = Number(o.price)
    const deltaAbs = Math.round((price - base) * 100) / 100
    const deltaPct = Math.round((deltaAbs / base) * 100 * 1000) / 1000

    const withinTolerance =
      Math.abs(deltaPct) < cfg.tolerance_pct || Math.abs(deltaAbs) < cfg.tolerance_abs

    if (withinTolerance) continue

    if (deltaAbs < 0) {
      findings.push({
        channelSlug: o.channel.slug,
        channelId: o.channel.id,
        kind: 'undercut',
        basePrice: base,
        channelPrice: price,
        deltaAbs,
        deltaPct,
        severity: severityFor(deltaPct, cfg.severity)
      })
    } else if (cfg.report_overcut && deltaPct >= cfg.overcut_min_pct) {
      findings.push({
        channelSlug: o.channel.slug,
        channelId: o.channel.id,
        kind: 'overcut',
        basePrice: base,
        channelPrice: price,
        deltaAbs,
        deltaPct,
        severity: 'info'
      })
    }
  }

  return findings
}

const SEVERITY_RANK = { info: 0, warning: 1, serious: 2, critical: 3 }

export function severityRank (s) {
  return SEVERITY_RANK[s] ?? 0
}

export function atLeast (severity, minimum) {
  return severityRank(severity) >= severityRank(minimum)
}
