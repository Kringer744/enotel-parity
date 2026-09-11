import { api } from '../api.js'
import { fmtDate, fmtRelative, pct, escapeHtml, toast, busy, skeleton, loading, refreshIcons } from '../ui.js'
import { lineChart, money2 } from '../charts.js'
import { state, TODAY, navigate, refreshNav } from '../core/state.js'
import { periodPicker, wirePeriod } from '../components/period.js'
import { waitForScan } from '../components/scan.js'
import { renderRanking } from '../components/ranking.js'
import { findingsTable, wireFindingRows } from '../components/findings-table.js'

/* ═══ Painel ══════════════════════════════════════════════════════════════ */

/**
 * Controles de data do cabecalho do Painel.
 * "Monitorar" so cadastra o periodo e espera a varredura agendada; "Puxar"
 * cadastra e varre na hora -- e esse o caminho que gasta requisicao.
 */
function wireHeadDates (main) {
  const ci = document.getElementById('h-checkin')
  const co = document.getElementById('h-checkout')

  // O check-out acompanha o check-in e nunca pode ser anterior a ele.
  ci.addEventListener('change', () => {
    const min = new Date(`${ci.value}T12:00:00Z`)
    min.setUTCDate(min.getUTCDate() + 1)
    co.min = min.toISOString().slice(0, 10)
    if (!co.value || co.value <= ci.value) co.value = co.min
  })

  const create = async () => {
    if (!ci.value || !co.value) throw new Error('Escolha as datas de entrada e saída')
    if (co.value <= ci.value) throw new Error('A saída precisa ser depois da entrada')
    const props = await api.properties()
    const prop = props.find((p) => p.active) || props[0]
    if (!prop) throw new Error('Nenhuma propriedade cadastrada')
    return api.createTarget({
      property_id: prop.id,
      mode: 'fixed',
      check_in: ci.value,
      check_out: co.value,
      adults: 2
    })
  }

  document.getElementById('h-add').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, '...')
    try {
      await create()
      toast('Período adicionado. Entra na próxima atualização.', 'ok')
      await renderPeriodChips()
    } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.getElementById('h-pull').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Atualizando...')
    try {
      await create()
      await api.runScan()
      document.getElementById('ranking').innerHTML =
        loading('Buscando os preços do período escolhido...', 260)
      const scan = await waitForScan()
      if (scan && (scan.status === 'ok' || scan.status === 'partial')) {
        toast(`${scan.rates_captured} preços coletados`, 'ok')
      } else if (scan) {
        toast(`A atualização não completou: ${scan.message || 'tente de novo em instantes'}`, 'error')
      }
      return pageDashboard(main)
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })
}

/** Períodos de data fixa em monitoramento, como chips removíveis. */
async function renderPeriodChips () {
  const host = document.getElementById('period-chips')
  if (!host) return

  const props = await api.properties().catch(() => [])
  const fixed = props.flatMap((p) => p.targets || [])
    .filter((t) => t.mode === 'fixed' && t.active)
    .sort((a, b) => String(a.check_in).localeCompare(String(b.check_in)))

  if (fixed.length === 0) {
    host.innerHTML =
      '<span class="muted small">Nenhum período específico monitorado. ' +
      'Escolha as datas acima para adicionar.</span>'
    return
  }

  host.innerHTML = '<span class="muted small">Períodos monitorados:</span>' +
    fixed.map((t) => `
      <span class="chip${t.auto_key ? ' auto' : ''}">
        <i data-lucide="${t.auto_key ? 'sparkles' : 'calendar-check'}" class="icon-sm"></i>
        ${fmtDate(t.check_in)} a ${fmtDate(t.check_out)}
        <button data-chip="${t.id}" title="Parar de monitorar">
          <i data-lucide="x" class="icon-sm"></i>
        </button>
      </span>`).join('')

  host.querySelectorAll('[data-chip]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api.deleteTarget(b.dataset.chip)
        toast('Período removido do monitoramento', 'ok')
        await renderPeriodChips()
      } catch (err) { toast(err.message, 'error') }
    }))

  refreshIcons(host)
}


export async function pageDashboard (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Painel</h1>
        <p class="page-sub" id="head-sub">Carregando…</p>
      </div>
      <div class="row wrap" style="gap:10px">
        ${periodPicker()}
        <div class="head-dates">
          <i data-lucide="calendar" class="icon-sm"></i>
          <input type="date" id="h-checkin" min="${TODAY}" title="Entrada">
          <span class="sep">até</span>
          <input type="date" id="h-checkout" min="${TODAY}" title="Saída">
          <button class="btn ghost small" id="h-add">Acompanhar</button>
          <button class="btn small" id="h-pull">Ver agora</button>
        </div>
        <button class="btn secondary" id="run-scan">Atualizar agora</button>
      </div>
    </div>
    <div id="period-chips" class="period-chips"></div>
    <div class="grid kpi" id="kpis">${[1, 2, 3, 4].map(() => skeleton(110)).join('')}</div>
    <div class="grid two" style="margin-top:16px">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Seu preço vs. os canais</div>
            <div class="card-note">Ranking pelo desvio frente ao seu preço oficial</div>
          </div>
        </div>
        <div id="ranking">${loading('Comparando canais...', 260)}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Preço médio por canal</div>
            <div class="card-note" id="trend-note">Diária média em reais</div>
          </div>
          <select class="select" id="trend-target" style="width:auto;max-width:210px" hidden></select>
        </div>
        <div id="trend">${loading('Carregando série histórica...', 300)}</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div>
          <div class="card-title">Violações recentes</div>
          <div class="card-note">Canais vendendo abaixo do seu preço oficial</div>
        </div>
        <button class="btn ghost small" id="see-all">
          Ver todas <i data-lucide="arrow-right" class="icon-sm"></i>
        </button>
      </div>
      <div id="recent">${loading('Buscando violações...', 200)}</div>
    </div>`

  wirePeriod(() => pageDashboard(main))
  wireHeadDates(main)
  renderPeriodChips()
  document.getElementById('see-all').addEventListener('click', () => navigate('findings'))

  document.getElementById('run-scan').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget
    busy(btn, true, 'Atualizando...')
    try {
      await api.runScan()
      document.getElementById('ranking').innerHTML =
        loading('Buscando os preços nos canais...', 260)
      document.getElementById('trend').innerHTML =
        loading('Aguardando os preços da atualização...', 300)
      document.getElementById('recent').innerHTML =
        loading('Isso leva de 10 a 40 segundos...', 200)

      const scan = await waitForScan()
      if (scan?.status === 'ok' || scan?.status === 'partial') {
        toast(`Atualização concluída: ${scan.rates_captured} preços, ${scan.findings_count} achados`, 'ok')
      } else if (scan) {
        toast(`A atualização não completou: ${scan.message || 'tente de novo em instantes'}`, 'error')
      }
      if (state.page === 'dashboard') return pageDashboard(main)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      busy(btn, false)
    }
  })

  const [ov, trend, compliance, findings, rates] = await Promise.all([
    api.overview(), api.trend(state.days, state.trendTarget), api.compliance(state.days),
    api.findings({ days: state.days, limit: 8 }), api.currentRates()
  ])

  state.openCount = ov.openTotal
  refreshNav()

  document.getElementById('head-sub').textContent = ov.lastScan
    ? `Última atualização ${fmtRelative(ov.lastScan.started_at)} · ${ov.lastScan.rates_captured} preços coletados`
    : 'Nenhuma atualização feita ainda'

  const b = ov.budget
  const budgetTone = b.pctUsed >= 90 ? 'is-critical' : b.pctUsed >= 70 ? 'is-warning' : ''

  document.getElementById('kpis').innerHTML = `
    <div class="card stat">
      <div class="stat-label">Violações abertas (7 dias)</div>
      <div class="stat-value hero">${ov.openTotal}</div>
      <div class="stat-meta">
        ${ov.openBySeverity.critical} críticas · ${ov.openBySeverity.serious} graves · ${ov.openBySeverity.warning} atenção
      </div>
    </div>
    <div class="card stat">
      <div class="stat-label">Conformidade da última atualização</div>
      <div class="stat-value">${ov.complianceRate === null ? '—' : pct(ov.complianceRate)}</div>
      <div class="stat-meta">${ov.violations} de ${ov.comparisons} comparações fora da paridade</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Maior desconto de um canal</div>
      <div class="stat-value">${ov.worstGap ? pct(Math.abs(ov.worstGap.delta_pct)) : '—'}</div>
      <div class="stat-meta">
        ${ov.worstGap
          ? `${escapeHtml(ov.worstGap.channel_name)} · ${money2(ov.worstGap.channel_price)} vs ${money2(ov.worstGap.base_price)}`
          : 'Nenhuma violação no período'}
      </div>
    </div>
    <div class="card stat">
      <div class="stat-label">
        Consultas de preço · ${b.month}
        ${b.live
          ? '<span class="badge good"><i data-lucide="wifi" class="icon-sm"></i>em dia</span>'
          : '<span class="badge warning"><i data-lucide="wifi-off" class="icon-sm"></i>estimado</span>'}
      </div>
      <div class="stat-value">${b.used}<span style="font-size:18px;color:var(--ink-3)"> / ${b.limit}</span></div>
      <div class="stat-meta">
        ${b.live
          ? `${b.remaining} restantes este mês`
          : `Não consegui conferir o saldo agora${b.liveError ? `: ${escapeHtml(b.liveError)}` : ''}`}
      </div>
      <div class="stat-meta">
        ${b.willExceed
          ? `No ritmo atual chega a ${b.projected} até o fim do mês`
          : `${b.perScan} consultas por atualização · renova todo mês`}
      </div>
      <div class="meter ${budgetTone}"><span style="width:${Math.min(100, b.pctUsed)}%"></span></div>
      <button class="btn ghost small" id="sync-budget" style="margin-top:8px;padding-left:0">
        Conferir o saldo
      </button>
    </div>`

  document.getElementById('sync-budget').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Sincronizando…')
    try {
      const r = await api.budgetSync()
      toast(r.synced
        ? `Saldo conferido: ${r.real} consultas usadas este mês`
        : `Não foi possível ler a conta: ${r.error}`, r.synced ? 'ok' : 'error')
      if (r.synced) pageDashboard(main)
    } catch (err) {
      toast(err.message, 'error')
      busy(ev.currentTarget, false)
    }
  })

  // Um alvo por vez: plotar juntos misturaria níveis de preço de check-ins
  // diferentes e a curva não significaria nada.
  const targetSelect = document.getElementById('trend-target')
  if ((trend.targets || []).length > 1) {
    targetSelect.hidden = false
    targetSelect.innerHTML = trend.targets.map((t) => `
      <option value="${t.id}" ${trend.target?.id === t.id ? 'selected' : ''}>
        ${escapeHtml(t.label)}
      </option>`).join('')
    targetSelect.addEventListener('change', () => {
      state.trendTarget = Number(targetSelect.value)
      pageDashboard(main)
    })
  }

  document.getElementById('trend-note').textContent =
    trend.target
      ? (trend.target.mode === 'fixed'
          ? `Diária média em reais · entrada ${fmtDate(trend.target.check_in)}`
          : `Diária média em reais · ${trend.target.label}`)
      : 'Diária média em reais'

  lineChart(document.getElementById('trend'), {
    dates: trend.dates,
    series: trend.series.map((s) => ({ name: s.name, color: s.color, values: s.values })),
    height: 300
  })

  renderRanking(document.getElementById('ranking'), rates, compliance)

  document.getElementById('recent').innerHTML = findingsTable(findings)
  wireFindingRows()
  refreshIcons(main)
}
