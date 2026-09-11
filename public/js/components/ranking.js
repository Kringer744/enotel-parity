import { escapeHtml, pct, emptyState, refreshIcons } from '../ui.js'
import { money2 } from '../charts.js'

/* ═══ Ranking: site oficial vs. OTAs ══════════════════════════════════════ */

/**
 * Agrega o snapshot mais recente por canal. O ranking é ordenado pelo PIOR
 * desvio, não pela média: uma OTA que fura a paridade em uma única data já é
 * um problema contratual, e a média esconderia isso.
 */
export function buildRanking (rates, compliance) {
  const byChannel = new Map()
  let anchorSum = 0
  let anchorCount = 0

  for (const g of rates) {
    if (g.directPrice) { anchorSum += g.directPrice; anchorCount += 1 }
    for (const o of g.offers) {
      if (o.kind !== 'ota' || o.deltaPct === null) continue
      if (!byChannel.has(o.slug)) {
        byChannel.set(o.slug, { slug: o.slug, name: o.name, color: o.color, deltas: [], prices: [] })
      }
      const entry = byChannel.get(o.slug)
      entry.deltas.push(o.deltaPct)
      entry.prices.push(o.price)
    }
  }

  const withData = [...byChannel.values()].map((e) => {
    const avg = e.deltas.reduce((a, b) => a + b, 0) / e.deltas.length
    return {
      ...e,
      hasData: true,
      worst: Math.min(...e.deltas),
      avg: Math.round(avg * 10) / 10,
      avgPrice: e.prices.reduce((a, b) => a + b, 0) / e.prices.length,
      undercuts: e.deltas.filter((d) => d < -1).length,
      dates: e.deltas.length
    }
  }).sort((a, b) => a.worst - b.worst)

  // Canais monitorados que não apareceram na oferta entram no fim, marcados
  // como sem dados -- nunca como 0% de conformidade, que leria como violação.
  const seen = new Set(withData.map((r) => r.slug))
  const missing = compliance
    .filter((c) => !seen.has(c.slug))
    .map((c) => ({ slug: c.slug, name: c.name, color: c.color, hasData: false }))

  return {
    rows: [...withData, ...missing],
    anchor: anchorCount > 0 ? anchorSum / anchorCount : null,
    dateCount: rates.length
  }
}

export function renderRanking (host, rates, compliance) {
  const { rows, anchor, dateCount } = buildRanking(rates, compliance)

  if (rows.length === 0 || anchor === null) {
    host.innerHTML = emptyState('info',
      anchor === null && rates.length > 0
        ? 'Sem tarifa do site oficial na última varredura — não há âncora para comparar.'
        : 'Nenhuma tarifa coletada ainda. Rode uma varredura para montar o ranking.')
    refreshIcons(host)
    return
  }

  // Escala da barra divergente: o maior desvio absoluto define as pontas.
  const scale = Math.max(...rows.filter((r) => r.hasData).map((r) => Math.abs(r.worst)), 5)

  host.innerHTML = `
    <div class="rank-anchor">
      <i data-lucide="anchor" class="icon-sm"></i>
      <span class="rank-anchor-label">
        Tarifa do site oficial · média de ${dateCount} ${dateCount === 1 ? 'data' : 'datas'}
      </span>
      <span class="rank-anchor-value">${money2(anchor)}</span>
    </div>
    ${rows.map((r, i) => {
      if (!r.hasData) {
        return `
          <div class="rank-row no-data">
            <div class="rank-pos">—</div>
            <div class="rank-name">
              <span class="channel-swatch" style="background:${r.color}"></span>
              <span><span class="label">${escapeHtml(r.name)}</span></span>
            </div>
            <div class="rank-bar"></div>
            <div class="rank-delta"><span class="sub">sem oferta</span></div>
            <span class="badge neutral">Sem dados</span>
          </div>`
      }

      const violating = r.worst < -1
      const width = Math.min(50, (Math.abs(r.worst) / scale) * 50)
      const cls = r.worst < 0 ? 'neg' : 'pos'

      return `
        <div class="rank-row ${violating ? 'violating' : ''}">
          <div class="rank-pos">${i + 1}</div>
          <div class="rank-name">
            <span class="channel-swatch" style="background:${r.color}"></span>
            <span>
              <span class="label">${escapeHtml(r.name)}</span>
              <span class="sub">${money2(r.avgPrice)} · média de ${r.dates} ${r.dates === 1 ? 'data' : 'datas'}</span>
            </span>
          </div>
          <div class="rank-bar"><span class="${cls}" style="width:${width}%"></span></div>
          <div class="rank-delta ${cls}">
            ${r.worst > 0 ? '+' : ''}${pct(r.worst)}
            <span class="sub">pior desvio</span>
          </div>
          ${violating
            ? `<span class="badge critical">
                 <i data-lucide="ban" class="icon-sm"></i>
                 ${r.undercuts} de ${r.dates}
               </span>`
            : '<span class="badge good"><i data-lucide="check" class="icon-sm"></i>Em paridade</span>'}
        </div>`
    }).join('')}`

  refreshIcons(host)
}
