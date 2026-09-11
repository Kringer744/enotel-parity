import { api, downloadCsv } from '../api.js'
import { fmtDateTime, pct, escapeHtml, statusBadge, toast, busy, loading } from '../ui.js'
import { lineChart, barChart, heatmap } from '../charts.js'
import { state } from '../core/state.js'
import { periodPicker, wirePeriod } from '../components/period.js'
import { findingsTable, wireFindingRows } from '../components/findings-table.js'

/* ═══ Relatório ═══════════════════════════════════════════════════════════ */

export async function pageReport (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Relatório de paridade</h1>
        <p class="page-sub" id="rep-sub">Gerando…</p>
      </div>
      <div class="row wrap">
        ${periodPicker()}
        <button class="btn secondary" id="csv">Exportar CSV</button>
        <button class="btn secondary" id="print">Imprimir / PDF</button>
      </div>
    </div>
    <div id="report-body">${loading('Gerando relatório...', 500)}</div>`

  wirePeriod(() => pageReport(main))
  document.getElementById('print').addEventListener('click', () => window.print())
  document.getElementById('csv').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Exportando…')
    try { await downloadCsv(state.days); toast('CSV exportado', 'ok') } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  const r = await api.report(state.days)
  const ov = r.overview

  document.getElementById('rep-sub').textContent =
    `Período de ${r.periodDays} dias · gerado em ${fmtDateTime(r.generatedAt)}`

  // Uma linha por canal no heatmap, células indexadas por dia.
  const heatRows = []
  const byChannel = new Map()
  for (const h of r.heatmap) {
    if (!byChannel.has(h.slug)) byChannel.set(h.slug, { name: h.name, cells: {} })
    byChannel.get(h.slug).cells[h.day] = h.violations
  }
  const channelColor = Object.fromEntries(r.compliance.map((c) => [c.name, c.color]))
  for (const [, v] of byChannel) {
    heatRows.push({ name: v.name, color: channelColor[v.name] || '#2a78d6', cells: v.cells })
  }
  const heatDates = [...new Set(r.heatmap.map((h) => h.day))].sort()

  const totalViolations = r.findings.filter((f) => f.kind === 'undercut').length
  const scansOk = r.history.filter((s) => s.status === 'ok' || s.status === 'partial').length

  document.getElementById('report-body').innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div class="card-title">Resumo executivo</div></div>
      <div class="grid kpi">
        <div class="stat">
          <div class="stat-label">Atualizações no período</div>
          <div class="stat-value">${scansOk}</div>
          <div class="stat-meta">${r.history.reduce((a, s) => a + s.requests_used, 0)} consultas de preço</div>
        </div>
        <div class="stat">
          <div class="stat-label">Violações detectadas</div>
          <div class="stat-value">${totalViolations}</div>
          <div class="stat-meta">${ov.openBySeverity.critical} críticas nos últimos 7 dias</div>
        </div>
        <div class="stat">
          <div class="stat-label">Conformidade geral</div>
          <div class="stat-value">${ov.complianceRate === null ? '—' : pct(ov.complianceRate)}</div>
          <div class="stat-meta">na última atualização concluída</div>
        </div>
        <div class="stat">
          <div class="stat-label">Canal mais crítico</div>
          <div class="stat-value" style="font-size:22px">${
            r.compliance.length
              ? escapeHtml([...r.compliance].sort((a, b) => (a.complianceRate ?? 101) - (b.complianceRate ?? 101))[0].name)
              : '—'}</div>
          <div class="stat-meta">menor taxa de conformidade</div>
        </div>
      </div>
    </div>

    <div class="grid two" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">Evolução dos preços</div>
          <div class="card-note">${r.trend.target ? escapeHtml(r.trend.target.label) : 'Diária média por canal'}</div>
        </div></div>
        <div id="r-trend"></div>
      </div>
      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">Conformidade por canal</div>
          <div class="card-note">% de comparações dentro da paridade</div>
        </div></div>
        <div id="r-compliance"></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div>
        <div class="card-title">Violações por dia e canal</div>
        <div class="card-note">Intensidade da cor = número de violações no dia</div>
      </div></div>
      <div id="r-heat"></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div class="card-title">Detalhamento por canal</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Canal</th><th class="num">Comparações</th><th class="num">Violações</th>
            <th class="num">Conformidade</th><th class="num">Desvio médio</th><th class="num">Pior desvio</th>
          </tr></thead>
          <tbody>
            ${r.compliance.map((c) => `
              <tr>
                <td><span class="channel-key">
                  <span class="channel-swatch" style="background:${c.color}"></span>${escapeHtml(c.name)}
                </span></td>
                <td class="num mono">${c.comparisons}</td>
                <td class="num mono">${c.violations}</td>
                <td class="num mono strong">${c.complianceRate === null ? '—' : pct(c.complianceRate)}</td>
                <td class="num mono">${c.avg_delta === null ? '—' : pct(c.avg_delta)}</td>
                <td class="num mono">${c.worst_delta === null ? '—' : pct(c.worst_delta)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div class="card-title">Ocorrências detalhadas</div>
        <div class="card-note">${r.findings.length} registro(s)</div></div>
      ${findingsTable(r.findings.slice(0, 120))}
    </div>

    <div class="card">
      <div class="card-head"><div class="card-title">Histórico de atualizações</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Início</th><th>Origem</th><th>Status</th>
            <th class="num">Consultas</th><th class="num">Preços</th><th class="num">Achados</th><th>Observação</th>
          </tr></thead>
          <tbody>
            ${r.history.map((s) => `
              <tr>
                <td class="mono small">${fmtDateTime(s.started_at)}</td>
                <td class="small">${s.trigger === 'manual' ? 'Manual' : 'Agendada'}</td>
                <td>${statusBadge(s.status)}</td>
                <td class="num mono">${s.requests_used}</td>
                <td class="num mono">${s.rates_captured}</td>
                <td class="num mono">${s.findings_count}</td>
                <td class="small muted">${escapeHtml(s.message || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`

  lineChart(document.getElementById('r-trend'), {
    dates: r.trend.dates,
    series: r.trend.series.map((s) => ({ name: s.name, color: s.color, values: s.values })),
    height: 280
  })

  // Canais sem comparação nenhuma ficam fora: 0% leria como violação total,
  // quando na verdade o canal simplesmente não apareceu na oferta.
  barChart(document.getElementById('r-compliance'), {
    items: r.compliance
      .filter((c) => c.comparisons > 0)
      .map((c) => ({
        name: c.name, color: c.color, value: c.complianceRate,
        detail: [
          { label: 'Comparações', value: c.comparisons },
          { label: 'Violações', value: c.violations },
          { label: 'Pior desvio', value: c.worst_delta !== null ? pct(c.worst_delta) : '—' }
        ]
      })),
    max: 100,
    valueFmt: (v) => `${v.toFixed(0)}%`
  })

  heatmap(document.getElementById('r-heat'), { rows: heatRows, dates: heatDates })
  wireFindingRows()
}
