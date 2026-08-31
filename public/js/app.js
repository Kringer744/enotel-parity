import { api, getToken, setToken, downloadCsv } from './api.js'
import {
  fmtDateTime, fmtDate, fmtRelative, pct, severityBadge, statusBadge,
  escapeHtml, toast, busy, skeleton, emptyState, KIND
} from './ui.js'
import { lineChart, barChart, heatmap, money2 } from './charts.js'

const root = document.getElementById('root')
const state = { user: null, page: 'dashboard', days: 30, openCount: 0 }

const NAV = [
  { id: 'dashboard', emoji: '📊', label: 'Painel' },
  { id: 'rates', emoji: '🏷️', label: 'Tarifas atuais' },
  { id: 'findings', emoji: '⚠️', label: 'Violações', badge: true },
  { id: 'report', emoji: '📄', label: 'Relatório' },
  { id: 'whatsapp', emoji: '💬', label: 'WhatsApp' },
  { id: 'settings', emoji: '⚙️', label: 'Configurações' }
]

/* ═══ Login ═══════════════════════════════════════════════════════════════ */

function renderLogin (message = '') {
  root.innerHTML = `
    <div class="login-shell">
      <form class="login-card" id="login-form">
        <div class="login-mark">🏨</div>
        <h1 style="font-size:22px">Paridade Enotel</h1>
        <p class="page-sub" style="margin-bottom:26px">
          Monitoramento tarifário nas principais OTAs
        </p>
        ${message ? `<div class="badge critical" style="margin-bottom:16px">${escapeHtml(message)}</div>` : ''}
        <div class="field">
          <label for="email">E-mail</label>
          <input class="input" type="email" id="email" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="password">Senha</label>
          <input class="input" type="password" id="password" autocomplete="current-password" required>
        </div>
        <button class="btn block" type="submit" id="login-btn" style="margin-top:8px">Entrar</button>
      </form>
    </div>`

  document.getElementById('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const btn = document.getElementById('login-btn')
    busy(btn, true, 'Entrando…')
    try {
      const { token, user } = await api.login(
        document.getElementById('email').value,
        document.getElementById('password').value
      )
      setToken(token)
      state.user = user
      renderApp()
    } catch (err) {
      busy(btn, false)
      renderLogin(err.message)
    }
  })
}

/* ═══ Casca ═══════════════════════════════════════════════════════════════ */

function renderApp () {
  root.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">E</div>
          <div>
            <div class="brand-name">Paridade</div>
            <div class="brand-sub">Enotel BR</div>
          </div>
        </div>
        <div class="nav-label">Monitoramento</div>
        <nav id="nav"></nav>
        <div class="sidebar-foot">
          <div class="strong" style="color:var(--ink-2)">${escapeHtml(state.user?.name || '')}</div>
          <div style="margin-top:2px">${escapeHtml(state.user?.email || '')}</div>
          <button class="btn ghost small" id="logout" style="margin-top:10px;padding-left:0">Sair</button>
        </div>
      </aside>
      <main class="main" id="main"></main>
    </div>`

  document.getElementById('logout').addEventListener('click', () => {
    setToken(null)
    state.user = null
    renderLogin()
  })

  renderNav()
  go(state.page)
}

function renderNav () {
  const nav = document.getElementById('nav')
  if (!nav) return
  nav.innerHTML = NAV.map((n) => `
    <button class="nav-item ${state.page === n.id ? 'active' : ''}" data-page="${n.id}">
      <span class="nav-icon" aria-hidden="true">${n.emoji}</span>
      <span>${n.label}</span>
      ${n.badge && state.openCount > 0 ? `<span class="nav-badge">${state.openCount}</span>` : ''}
    </button>`).join('')

  nav.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.page)))
}

const PAGES = {
  dashboard: pageDashboard,
  rates: pageRates,
  findings: pageFindings,
  report: pageReport,
  whatsapp: pageWhatsApp,
  settings: pageSettings
}

async function go (page) {
  state.page = page
  renderNav()
  const main = document.getElementById('main')
  main.scrollTop = 0
  try {
    await PAGES[page](main)
  } catch (err) {
    if (err.status !== 401) {
      main.innerHTML = `<div class="card">${emptyState('⚠️', `Não foi possível carregar: ${err.message}`)}</div>`
    }
  }
}

function periodPicker () {
  return `
    <div class="segmented" id="period">
      ${[7, 30, 90].map((d) => `
        <button data-days="${d}" class="${state.days === d ? 'active' : ''}">${d} dias</button>
      `).join('')}
    </div>`
}

function wirePeriod (rerender) {
  document.getElementById('period')?.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.days = Number(b.dataset.days)
      rerender()
    }))
}

/* ═══ Painel ══════════════════════════════════════════════════════════════ */

async function pageDashboard (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Painel</h1>
        <p class="page-sub" id="head-sub">Carregando…</p>
      </div>
      <div class="row">
        ${periodPicker()}
        <button class="btn" id="run-scan">Varredura agora</button>
      </div>
    </div>
    <div class="grid kpi" id="kpis">${[1, 2, 3, 4].map(() => skeleton(110)).join('')}</div>
    <div class="grid two" style="margin-top:16px">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Tarifa média por canal</div>
            <div class="card-note" id="trend-note">Diária média em BRL</div>
          </div>
        </div>
        <div id="trend">${skeleton(300)}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Conformidade por canal</div>
            <div class="card-note">% de comparações dentro da paridade</div>
          </div>
        </div>
        <div id="compliance">${skeleton(260)}</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div>
          <div class="card-title">Violações recentes</div>
          <div class="card-note">Canais vendendo abaixo do site oficial</div>
        </div>
        <button class="btn ghost small" id="see-all">Ver todas →</button>
      </div>
      <div id="recent">${skeleton(200)}</div>
    </div>`

  wirePeriod(() => pageDashboard(main))
  document.getElementById('see-all').addEventListener('click', () => go('findings'))

  document.getElementById('run-scan').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget
    busy(btn, true, 'Varrendo…')
    try {
      await api.runScan()
      toast('Varredura iniciada. Os resultados aparecem em instantes.', 'ok')
      // A varredura roda em segundo plano; recarrega quando deve ter terminado.
      setTimeout(() => { if (state.page === 'dashboard') pageDashboard(main) }, 25000)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setTimeout(() => busy(btn, false), 1500)
    }
  })

  const [ov, trend, compliance, findings] = await Promise.all([
    api.overview(), api.trend(state.days), api.compliance(state.days),
    api.findings({ days: state.days, limit: 8 })
  ])

  state.openCount = ov.openTotal
  renderNav()

  document.getElementById('head-sub').textContent = ov.lastScan
    ? `Última varredura ${fmtRelative(ov.lastScan.started_at)} · ${ov.lastScan.rates_captured} tarifas coletadas`
    : 'Nenhuma varredura executada ainda'

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
      <div class="stat-label">Conformidade da última varredura</div>
      <div class="stat-value">${ov.complianceRate === null ? '—' : pct(ov.complianceRate)}</div>
      <div class="stat-meta">${ov.violations} de ${ov.comparisons} comparações fora da paridade</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Maior desconto de OTA</div>
      <div class="stat-value">${ov.worstGap ? pct(Math.abs(ov.worstGap.delta_pct)) : '—'}</div>
      <div class="stat-meta">
        ${ov.worstGap
          ? `${escapeHtml(ov.worstGap.channel_name)} · ${money2(ov.worstGap.channel_price)} vs ${money2(ov.worstGap.base_price)}`
          : 'Nenhuma violação no período'}
      </div>
    </div>
    <div class="card stat">
      <div class="stat-label">Orçamento SerpAPI · ${b.month}</div>
      <div class="stat-value">${b.used}<span style="font-size:18px;color:var(--ink-3)"> / ${b.limit}</span></div>
      <div class="stat-meta">
        ${b.willExceed
          ? `⚠️ No ritmo atual chega a ${b.projected} até o fim do mês`
          : `${b.perScan} req/varredura · ${b.daysLeft} dias restantes`}
      </div>
      <div class="meter ${budgetTone}"><span style="width:${Math.min(100, b.pctUsed)}%"></span></div>
    </div>`

  document.getElementById('trend-note').textContent =
    trend.target ? `Diária média em BRL · ${trend.target.label}` : 'Diária média em BRL'
  lineChart(document.getElementById('trend'), {
    dates: trend.dates,
    series: trend.series.map((s) => ({ name: s.name, color: s.color, values: s.values })),
    height: 300
  })

  barChart(document.getElementById('compliance'), {
    items: compliance.map((c) => ({
      name: c.name,
      color: c.color,
      value: c.complianceRate ?? 0,
      detail: [
        { label: 'Comparações', value: c.comparisons },
        { label: 'Violações', value: c.violations },
        { label: 'Desvio médio', value: c.avg_delta !== null ? pct(c.avg_delta) : '—' },
        { label: 'Pior desvio', value: c.worst_delta !== null ? pct(c.worst_delta) : '—' }
      ]
    })),
    max: 100,
    valueFmt: (v) => `${v.toFixed(0)}%`
  })

  document.getElementById('recent').innerHTML = findingsTable(findings)
  wireFindingRows()
}

/* ═══ Tarifas atuais ══════════════════════════════════════════════════════ */

async function pageRates (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Tarifas atuais</h1>
        <p class="page-sub">Fotografia da última varredura, por data de check-in</p>
      </div>
    </div>
    <div id="rates">${skeleton(320)}</div>`

  const groups = await api.currentRates()
  const host = document.getElementById('rates')

  if (groups.length === 0) {
    host.innerHTML = `<div class="card">${emptyState('🏷️', 'Nenhuma tarifa coletada ainda. Rode uma varredura no Painel.')}</div>`
    return
  }

  host.innerHTML = groups.map((g) => {
    const sorted = [...g.offers].sort((a, b) => a.price - b.price)
    const cheapest = sorted[0]
    return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(g.targetLabel || `Check-in ${fmtDate(g.checkIn)}`)}</div>
          <div class="card-note">
            ${fmtDate(g.checkIn)} → ${fmtDate(g.checkOut)} · ${g.los} noites ·
            tarifa direta ${g.directPrice ? money2(g.directPrice) : '<span class="badge warning">ausente</span>'}
          </div>
        </div>
        ${cheapest ? `<div class="badge ${cheapest.kind === 'direct' ? 'good' : 'critical'}">
          ${cheapest.kind === 'direct' ? '✓ Direto é o mais barato' : `⛔ ${escapeHtml(cheapest.name)} está mais barato`}
        </div>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Canal</th><th class="num">Diária</th><th class="num">vs. direto</th><th>Situação</th>
          </tr></thead>
          <tbody>
            ${sorted.map((o) => `
              <tr>
                <td>
                  <span class="channel-key">
                    <span class="channel-swatch" style="background:${o.color}"></span>
                    ${escapeHtml(o.name)}${o.kind === 'direct' ? ' <span class="badge neutral">âncora</span>' : ''}
                  </span>
                </td>
                <td class="num strong">${money2(o.price)}</td>
                <td class="num mono">${o.deltaPct === null ? '—' : `${o.deltaPct > 0 ? '+' : ''}${pct(o.deltaPct)}`}</td>
                <td>${
                  o.kind === 'direct' ? '<span class="badge info">Referência</span>'
                  : o.deltaPct === null ? '<span class="badge neutral">—</span>'
                  : o.deltaPct < -1 ? '<span class="badge critical"><span aria-hidden="true">⛔</span>Fura paridade</span>'
                  : o.deltaPct > 1 ? '<span class="badge neutral"><span aria-hidden="true">↑</span>Acima do direto</span>'
                  : '<span class="badge good"><span aria-hidden="true">✓</span>Em paridade</span>'
                }</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`
  }).join('')
}

/* ═══ Violações ═══════════════════════════════════════════════════════════ */

function findingsTable (findings) {
  if (findings.length === 0) {
    return emptyState('✅', 'Nenhuma violação de paridade no período. Todos os canais em conformidade.')
  }
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Detectado</th><th>Canal</th><th>Check-in</th>
          <th class="num">Direto</th><th class="num">Canal</th><th class="num">Diferença</th>
          <th>Severidade</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${findings.map((f) => `
            <tr data-id="${f.id}">
              <td class="muted small">${fmtDateTime(f.created_at)}</td>
              <td>
                <span class="channel-key">
                  <span class="channel-swatch" style="background:${f.channel_color || 'var(--ink-3)'}"></span>
                  ${escapeHtml(f.channel_name || '—')}
                </span>
                <div class="muted small" style="margin-top:2px">${KIND[f.kind] || f.kind}</div>
              </td>
              <td class="mono">${fmtDate(f.check_in)}<div class="muted small">${f.los || 2} noites</div></td>
              <td class="num mono">${money2(f.base_price)}</td>
              <td class="num mono strong">${money2(f.channel_price)}</td>
              <td class="num mono" style="color:${f.delta_pct < 0 ? 'var(--critical)' : 'var(--ink-2)'}">
                ${f.delta_pct === null ? '—' : `${f.delta_pct > 0 ? '+' : ''}${pct(f.delta_pct)}`}
                <div class="muted small">${f.delta_abs === null ? '' : money2(Math.abs(f.delta_abs)) + '/noite'}</div>
              </td>
              <td>${severityBadge(f.severity)}</td>
              <td>${statusBadge(f.status)}</td>
              <td>
                ${f.status === 'open'
                  ? `<button class="btn secondary small" data-ack="${f.id}">Marcar ciente</button>`
                  : f.status === 'acknowledged'
                  ? `<button class="btn secondary small" data-resolve="${f.id}">Resolver</button>`
                  : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`
}

function wireFindingRows () {
  document.querySelectorAll('[data-ack],[data-resolve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.ack || btn.dataset.resolve
      const status = btn.dataset.ack ? 'acknowledged' : 'resolved'
      busy(btn, true, '…')
      try {
        await api.updateFinding(id, status)
        toast('Status atualizado', 'ok')
        go(state.page)
      } catch (err) {
        busy(btn, false)
        toast(err.message, 'error')
      }
    })
  })
}

async function pageFindings (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Violações de paridade</h1>
        <p class="page-sub">Canais vendendo fora da tarifa do site oficial</p>
      </div>
      <div class="row wrap">
        ${periodPicker()}
        <select class="select" id="f-sev" style="width:auto">
          <option value="">Todas as severidades</option>
          <option value="critical">Crítico</option>
          <option value="serious">Grave</option>
          <option value="warning">Atenção</option>
        </select>
        <select class="select" id="f-status" style="width:auto">
          <option value="">Todos os status</option>
          <option value="open">Aberto</option>
          <option value="acknowledged">Ciente</option>
          <option value="resolved">Resolvido</option>
        </select>
      </div>
    </div>
    <div class="card"><div id="list">${skeleton(300)}</div></div>`

  wirePeriod(() => pageFindings(main))

  const load = async () => {
    const params = { days: state.days, limit: 300 }
    const sev = document.getElementById('f-sev').value
    const st = document.getElementById('f-status').value
    if (sev) params.severity = sev
    if (st) params.status = st
    document.getElementById('list').innerHTML = skeleton(300)
    const findings = await api.findings(params)
    document.getElementById('list').innerHTML = findingsTable(findings)
    wireFindingRows()
  }

  document.getElementById('f-sev').addEventListener('change', load)
  document.getElementById('f-status').addEventListener('change', load)
  await load()
}

/* ═══ Relatório ═══════════════════════════════════════════════════════════ */

async function pageReport (main) {
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
    <div id="report-body">${skeleton(500)}</div>`

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
          <div class="stat-label">Varreduras no período</div>
          <div class="stat-value">${scansOk}</div>
          <div class="stat-meta">${r.history.reduce((a, s) => a + s.requests_used, 0)} requisições SerpAPI</div>
        </div>
        <div class="stat">
          <div class="stat-label">Violações detectadas</div>
          <div class="stat-value">${totalViolations}</div>
          <div class="stat-meta">${ov.openBySeverity.critical} críticas nos últimos 7 dias</div>
        </div>
        <div class="stat">
          <div class="stat-label">Conformidade geral</div>
          <div class="stat-value">${ov.complianceRate === null ? '—' : pct(ov.complianceRate)}</div>
          <div class="stat-meta">na última varredura concluída</div>
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
          <div class="card-title">Evolução das tarifas</div>
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
      <div class="card-head"><div class="card-title">Histórico de varreduras</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Início</th><th>Origem</th><th>Status</th>
            <th class="num">Requisições</th><th class="num">Tarifas</th><th class="num">Achados</th><th>Observação</th>
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

  barChart(document.getElementById('r-compliance'), {
    items: r.compliance.map((c) => ({
      name: c.name, color: c.color, value: c.complianceRate ?? 0,
      detail: [
        { label: 'Comparações', value: c.comparisons },
        { label: 'Violações', value: c.violations }
      ]
    })),
    max: 100,
    valueFmt: (v) => `${v.toFixed(0)}%`
  })

  heatmap(document.getElementById('r-heat'), { rows: heatRows, dates: heatDates })
  wireFindingRows()
}

/* ═══ WhatsApp ════════════════════════════════════════════════════════════ */

let qrTimer = null

async function pageWhatsApp (main) {
  clearInterval(qrTimer)

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>WhatsApp</h1>
        <p class="page-sub">Conecte o número e escolha quem recebe os avisos de paridade</p>
      </div>
    </div>
    <div class="grid two">
      <div class="card"><div id="wa-conn">${skeleton(280)}</div></div>
      <div class="card"><div id="wa-recip">${skeleton(280)}</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div>
        <div class="card-title">Prévia da mensagem</div>
        <div class="card-note">Formato do alerta que chega no aparelho</div>
      </div></div>
      <div class="wa-preview">
        <div class="wa-bubble">🔴 <b>Alerta de Paridade — Enotel BR</b>

<b>Enotel Porto de Galinhas</b>
Varredura de 31/08/2026 06:10
<b>2</b> violações encontradas

🔴 <b>Booking.com</b> — CRITICO
   Check-in 30/09 · 2 noites
   Direto: R$ 1.240,00  →  Canal: R$ 1.078,00
   Diferença: -13,1% (R$ 162,00/noite)

🟡 <b>Trip.com</b> — ATENCAO
   Check-in 30/10 · 2 noites
   Direto: R$ 1.180,00  →  Canal: R$ 1.145,00
   Diferença: -3,0% (R$ 35,00/noite)

<i>SerpAPI: 87/250 requisições usadas no mês</i></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="card-title">Envios recentes</div></div>
      <div id="wa-log">${skeleton(140)}</div>
    </div>`

  await renderWaConnection()
  await renderWaRecipients()
  await renderWaLog()
}

async function renderWaConnection () {
  const host = document.getElementById('wa-conn')
  if (!host) return

  let status
  try {
    status = await api.waStatus()
  } catch (err) {
    host.innerHTML = emptyState('⚠️', err.message)
    return
  }

  if (!status.configured) {
    host.innerHTML = `
      <div class="card-head"><div class="card-title">Conexão</div></div>
      ${emptyState('🔌', 'Defina UAZAPI_URL e UAZAPI_ADMIN_TOKEN nas variáveis de ambiente do EasyPanel para habilitar o WhatsApp.')}`
    return
  }

  if (status.connected) {
    host.innerHTML = `
      <div class="card-head">
        <div class="card-title">Conexão</div>
        <span class="badge good"><span aria-hidden="true">✓</span>Conectado</span>
      </div>
      <div class="row" style="gap:14px;margin-bottom:18px">
        <div class="avatar" style="width:48px;height:48px;font-size:18px">💬</div>
        <div>
          <div class="strong">${escapeHtml(status.profileName || 'WhatsApp conectado')}</div>
          <div class="muted small mono">${escapeHtml(status.number || '')}</div>
        </div>
      </div>
      <div class="row wrap">
        <button class="btn secondary" id="wa-refresh-contacts">Carregar contatos</button>
        <button class="btn secondary danger" id="wa-disconnect">Desconectar</button>
      </div>
      <div id="contacts" style="margin-top:16px"></div>`

    document.getElementById('wa-disconnect').addEventListener('click', async (ev) => {
      busy(ev.currentTarget, true, 'Desconectando…')
      try { await api.waDisconnect(); toast('Desconectado', 'ok'); await renderWaConnection() } catch (err) { toast(err.message, 'error') }
    })
    document.getElementById('wa-refresh-contacts').addEventListener('click', loadContacts)
    return
  }

  host.innerHTML = `
    <div class="card-head">
      <div class="card-title">Conexão</div>
      <span class="badge warning"><span aria-hidden="true">⚡</span>${status.instance ? 'Desconectado' : 'Sem instância'}</span>
    </div>
    <p class="muted small" style="margin-bottom:16px">
      ${status.instance
        ? 'Gere o QR code e leia com o WhatsApp do celular em Aparelhos conectados.'
        : 'Crie a instância na uazapi para começar.'}
    </p>
    <div id="qr-area"></div>
    <button class="btn block" id="wa-action" style="margin-top:14px">
      ${status.instance ? 'Gerar QR code' : 'Criar instância'}
    </button>`

  document.getElementById('wa-action').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget
    busy(btn, true, 'Aguarde…')
    try {
      if (!status.instance) {
        await api.waInit('enotel-paridade')
        toast('Instância criada', 'ok')
        return renderWaConnection()
      }
      const conn = await api.waConnect()
      const area = document.getElementById('qr-area')
      if (conn.qrcode) {
        area.innerHTML = `
          <div class="qr-frame"><img src="${conn.qrcode}" alt="QR code de pareamento"></div>
          <p class="muted small" style="text-align:center;margin-top:12px">
            O código expira em cerca de 40 segundos e é renovado automaticamente.
          </p>`
        // Sonda a conexão: assim que o pareamento conclui, a tela troca sozinha.
        clearInterval(qrTimer)
        qrTimer = setInterval(async () => {
          const s = await api.waStatus().catch(() => null)
          if (s?.connected) {
            clearInterval(qrTimer)
            toast('WhatsApp conectado', 'ok')
            renderWaConnection()
          }
        }, 4000)
      } else if (conn.paircode) {
        area.innerHTML = `<div class="empty"><div class="empty-icon">🔢</div>
          Código de pareamento: <span class="strong mono" style="font-size:20px">${escapeHtml(conn.paircode)}</span></div>`
      } else {
        area.innerHTML = emptyState('⏳', 'A uazapi não devolveu QR code. Tente novamente em instantes.')
      }
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      busy(btn, false)
    }
  })
}

async function loadContacts () {
  const host = document.getElementById('contacts')
  if (!host) return
  host.innerHTML = skeleton(200)
  try {
    const contacts = await api.waContacts()
    if (contacts.length === 0) {
      host.innerHTML = emptyState('👤', 'Nenhuma conversa encontrada. Envie uma mensagem pelo celular e recarregue.')
      return
    }
    host.innerHTML = `
      <div class="field" style="margin-bottom:10px">
        <input class="input" id="c-search" placeholder="Buscar contato ou grupo…">
      </div>
      <div class="contact-list" id="c-list"></div>`

    const draw = (term = '') => {
      const filtered = contacts.filter((c) =>
        !term || c.name.toLowerCase().includes(term.toLowerCase()) || (c.phone || '').includes(term))
      document.getElementById('c-list').innerHTML = filtered.slice(0, 100).map((c) => `
        <div class="contact-row" data-jid="${escapeHtml(c.jid)}"
             data-name="${escapeHtml(c.name)}" data-phone="${escapeHtml(c.phone || '')}"
             data-group="${c.isGroup}">
          <div class="avatar">${c.image ? `<img src="${escapeHtml(c.image)}" alt="">` : (c.isGroup ? '👥' : escapeHtml(c.name.charAt(0).toUpperCase()))}</div>
          <div>
            <div class="contact-name">${escapeHtml(c.name)}</div>
            <div class="contact-meta">${c.isGroup ? 'Grupo' : escapeHtml(c.phone || '')}</div>
          </div>
          <button class="btn small" style="margin-left:auto">Selecionar</button>
        </div>`).join('')

      document.getElementById('c-list').querySelectorAll('.contact-row').forEach((row) =>
        row.addEventListener('click', async () => {
          try {
            await api.waAddRecipient({
              name: row.dataset.name,
              phone: row.dataset.phone,
              jid: row.dataset.jid,
              is_group: row.dataset.group === 'true'
            })
            toast(`${row.dataset.name} receberá os alertas`, 'ok')
            await renderWaRecipients()
          } catch (err) { toast(err.message, 'error') }
        }))
    }

    draw()
    document.getElementById('c-search').addEventListener('input', (ev) => draw(ev.target.value))
  } catch (err) {
    host.innerHTML = emptyState('⚠️', err.message)
  }
}

async function renderWaRecipients () {
  const host = document.getElementById('wa-recip')
  if (!host) return
  const list = await api.waRecipients().catch(() => [])

  host.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-title">Destinatários dos alertas</div>
        <div class="card-note">Quem recebe os avisos de paridade</div>
      </div>
    </div>
    ${list.length === 0
      ? emptyState('📭', 'Nenhum destinatário. Conecte o WhatsApp e selecione um contato, ou adicione um número abaixo.')
      : `<div class="contact-list" style="margin-bottom:16px">
          ${list.map((r) => `
            <div class="contact-row">
              <div class="avatar">${r.is_group ? '👥' : escapeHtml(r.name.charAt(0).toUpperCase())}</div>
              <div>
                <div class="contact-name">${escapeHtml(r.name)}</div>
                <div class="contact-meta">${escapeHtml(r.phone)}</div>
              </div>
              <div class="row" style="margin-left:auto;gap:8px">
                <button class="btn ghost small" data-test="${escapeHtml(r.jid || r.phone)}">Testar</button>
                <label class="switch">
                  <input type="checkbox" data-toggle="${r.id}" ${r.active ? 'checked' : ''}>
                  <span class="track"></span>
                </label>
                <button class="btn ghost small" data-del="${r.id}" title="Remover">✕</button>
              </div>
            </div>`).join('')}
        </div>`}
    <div class="divider"></div>
    <div class="card-note" style="margin-bottom:10px">Adicionar número manualmente</div>
    <div class="row wrap" style="gap:8px">
      <input class="input" id="m-name" placeholder="Nome" style="flex:1;min-width:130px">
      <input class="input" id="m-phone" placeholder="5581999998888" style="flex:1;min-width:150px">
      <button class="btn" id="m-add">Adicionar</button>
    </div>`

  host.querySelectorAll('[data-toggle]').forEach((sw) =>
    sw.addEventListener('change', async () => {
      try { await api.waToggleRecipient(sw.dataset.toggle, sw.checked) } catch (err) { toast(err.message, 'error') }
    }))

  host.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await api.waRemoveRecipient(b.dataset.del); await renderWaRecipients() } catch (err) { toast(err.message, 'error') }
    }))

  host.querySelectorAll('[data-test]').forEach((b) =>
    b.addEventListener('click', async () => {
      busy(b, true, '…')
      try { await api.waTest(b.dataset.test); toast('Mensagem de teste enviada', 'ok') } catch (err) { toast(err.message, 'error') }
      busy(b, false)
    }))

  document.getElementById('m-add').addEventListener('click', async (ev) => {
    const name = document.getElementById('m-name').value.trim()
    const phone = document.getElementById('m-phone').value.trim()
    if (!name || !phone) return toast('Informe nome e telefone', 'error')
    busy(ev.currentTarget, true, '…')
    try {
      await api.waAddRecipient({ name, phone })
      toast('Destinatário adicionado', 'ok')
      await renderWaRecipients()
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })
}

async function renderWaLog () {
  const host = document.getElementById('wa-log')
  if (!host) return
  const log = await api.waNotifications().catch(() => [])
  host.innerHTML = log.length === 0
    ? emptyState('📨', 'Nenhum alerta enviado ainda.')
    : `<div class="table-wrap"><table>
        <thead><tr><th>Quando</th><th>Destinatário</th><th>Status</th><th>Observação</th></tr></thead>
        <tbody>${log.map((n) => `
          <tr>
            <td class="mono small">${fmtDateTime(n.created_at)}</td>
            <td>${escapeHtml(n.recipient_name || n.phone)}</td>
            <td>${statusBadge(n.status)}</td>
            <td class="small muted">${escapeHtml(n.error || '—')}</td>
          </tr>`).join('')}</tbody></table></div>`
}

/* ═══ Configurações ═══════════════════════════════════════════════════════ */

async function pageSettings (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Configurações</h1>
        <p class="page-sub">Regras de paridade, alvos de varredura e orçamento de API</p>
      </div>
    </div>
    <div id="settings-body">${skeleton(420)}</div>`

  const [s, props, budget] = await Promise.all([api.settings(), api.properties(), api.budget()])
  const p = s.parity
  const n = s.notifications

  document.getElementById('settings-body').innerHTML = `
    <div class="grid two">
      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">Regras de paridade</div>
          <div class="card-note">Ancoradas na tarifa do site oficial Enotel</div>
        </div></div>
        <div class="field">
          <label>Tolerância percentual — abaixo disso nada é reportado</label>
          <input class="input" type="number" step="0.1" id="tol-pct" value="${p.tolerance_pct}">
        </div>
        <div class="field">
          <label>Tolerância absoluta (R$ por diária)</label>
          <input class="input" type="number" step="0.5" id="tol-abs" value="${p.tolerance_abs}">
        </div>
        <div class="divider"></div>
        <div class="card-note" style="margin-bottom:10px">Faixas de severidade (% de desconto da OTA)</div>
        <div class="row wrap" style="gap:10px">
          <div style="flex:1;min-width:100px">
            <label class="small muted">Atenção ≥</label>
            <input class="input" type="number" step="0.5" id="sev-w" value="${p.severity.warning}">
          </div>
          <div style="flex:1;min-width:100px">
            <label class="small muted">Grave ≥</label>
            <input class="input" type="number" step="0.5" id="sev-s" value="${p.severity.serious}">
          </div>
          <div style="flex:1;min-width:100px">
            <label class="small muted">Crítico ≥</label>
            <input class="input" type="number" step="0.5" id="sev-c" value="${p.severity.critical}">
          </div>
        </div>
        <div class="divider"></div>
        <div class="row between">
          <div>
            <div class="strong">Reportar OTA acima do direto</div>
            <div class="muted small">Não fere contrato, mas indica perda de conversão</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="overcut" ${p.report_overcut ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>
        <button class="btn" id="save-parity" style="margin-top:18px">Salvar regras</button>
      </div>

      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">Notificações</div>
          <div class="card-note">Quando disparar o WhatsApp</div>
        </div></div>
        <div class="row between" style="margin-bottom:16px">
          <div><div class="strong">Alertas ativos</div>
            <div class="muted small">Desligue para pausar todos os envios</div></div>
          <label class="switch">
            <input type="checkbox" id="n-enabled" ${n.enabled ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>
        <div class="field">
          <label>Severidade mínima para notificar</label>
          <select class="select" id="n-sev">
            ${[['info', 'Tudo, inclusive info'], ['warning', 'Atenção ou mais grave'],
               ['serious', 'Apenas grave e crítico'], ['critical', 'Somente crítico']]
              .map(([v, l]) => `<option value="${v}" ${n.min_severity === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="row between">
          <div><div class="strong">Silenciar quando não há violação</div>
            <div class="muted small">Evita mensagem diária sem novidade</div></div>
          <label class="switch">
            <input type="checkbox" id="n-silent" ${n.silent_when_clean ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>
        <button class="btn" id="save-notif" style="margin-top:18px">Salvar notificações</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div>
          <div class="card-title">Alvos de varredura e orçamento SerpAPI</div>
          <div class="card-note">Cada alvo ativo consome 1 requisição por varredura</div>
        </div>
        <div class="badge ${budget.willExceed ? 'critical' : 'good'}">
          ${budget.willExceed ? '⛔' : '✓'} projeção ${budget.projected}/${budget.limit}
        </div>
      </div>
      <div class="grid kpi" style="margin-bottom:18px">
        <div class="stat"><div class="stat-label">Usadas neste mês</div>
          <div class="stat-value">${budget.used}</div>
          <div class="stat-meta">de ${budget.limit} disponíveis</div>
          <div class="meter ${budget.pctUsed >= 90 ? 'is-critical' : budget.pctUsed >= 70 ? 'is-warning' : ''}">
            <span style="width:${Math.min(100, budget.pctUsed)}%"></span></div>
        </div>
        <div class="stat"><div class="stat-label">Por varredura</div>
          <div class="stat-value">${budget.perScan}</div>
          <div class="stat-meta">alvos ativos hoje</div></div>
        <div class="stat"><div class="stat-label">Reserva manual</div>
          <div class="stat-value">${budget.reserve}</div>
          <div class="stat-meta">só disparos manuais podem usar</div></div>
        <div class="stat"><div class="stat-label">Teto sustentável</div>
          <div class="stat-value">${budget.maxTargetsPerScan}</div>
          <div class="stat-meta">alvos/varredura até o fim do mês</div></div>
      </div>
      ${props.map((prop) => `
        <div class="strong" style="margin-bottom:8px">${escapeHtml(prop.name)}
          <span class="muted small">· ${escapeHtml(prop.city || '')}</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Alvo</th><th class="num">Check-in em</th><th class="num">Noites</th>
              <th class="num">Adultos</th><th>Ativo</th><th></th></tr></thead>
            <tbody>
              ${prop.targets.map((t) => `
                <tr>
                  <td class="strong">${escapeHtml(t.label)}</td>
                  <td class="num mono">+${t.horizon_days} dias</td>
                  <td class="num mono">${t.los}</td>
                  <td class="num mono">${t.adults}</td>
                  <td><label class="switch">
                    <input type="checkbox" data-target="${t.id}" ${t.active ? 'checked' : ''}>
                    <span class="track"></span></label></td>
                  <td><button class="btn ghost small" data-deltarget="${t.id}">Remover</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="row wrap" style="gap:8px;margin-top:14px">
          <input class="input" id="t-label" placeholder="Nome do alvo" style="flex:2;min-width:150px">
          <input class="input" id="t-horizon" type="number" placeholder="Dias" style="flex:1;min-width:90px">
          <input class="input" id="t-los" type="number" value="2" placeholder="Noites" style="flex:1;min-width:90px">
          <button class="btn" id="t-add" data-prop="${prop.id}">Adicionar alvo</button>
        </div>`).join('')}
    </div>`

  document.getElementById('save-parity').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Salvando…')
    try {
      await api.updateSettings('parity', {
        tolerance_pct: Number(document.getElementById('tol-pct').value),
        tolerance_abs: Number(document.getElementById('tol-abs').value),
        report_overcut: document.getElementById('overcut').checked,
        severity: {
          warning: Number(document.getElementById('sev-w').value),
          serious: Number(document.getElementById('sev-s').value),
          critical: Number(document.getElementById('sev-c').value)
        }
      })
      toast('Regras de paridade salvas', 'ok')
    } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.getElementById('save-notif').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Salvando…')
    try {
      await api.updateSettings('notifications', {
        enabled: document.getElementById('n-enabled').checked,
        min_severity: document.getElementById('n-sev').value,
        silent_when_clean: document.getElementById('n-silent').checked
      })
      toast('Preferências de notificação salvas', 'ok')
    } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.querySelectorAll('[data-target]').forEach((sw) =>
    sw.addEventListener('change', async () => {
      try {
        await api.toggleTarget(sw.dataset.target, sw.checked)
        toast('Alvo atualizado — o orçamento muda a partir da próxima varredura', 'ok')
      } catch (err) { toast(err.message, 'error') }
    }))

  document.querySelectorAll('[data-deltarget]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await api.deleteTarget(b.dataset.deltarget); pageSettings(main) } catch (err) { toast(err.message, 'error') }
    }))

  document.getElementById('t-add')?.addEventListener('click', async (ev) => {
    const label = document.getElementById('t-label').value.trim()
    const horizon = Number(document.getElementById('t-horizon').value)
    const los = Number(document.getElementById('t-los').value) || 2
    if (!label || !horizon) return toast('Informe nome e número de dias', 'error')
    busy(ev.currentTarget, true, '…')
    try {
      await api.createTarget({ property_id: Number(ev.currentTarget.dataset.prop), label, horizon_days: horizon, los })
      toast('Alvo adicionado', 'ok')
      pageSettings(main)
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })
}

/* ═══ Boot ════════════════════════════════════════════════════════════════ */

window.addEventListener('auth:expired', () => renderLogin('Sua sessão expirou. Entre novamente.'))

async function boot () {
  if (!getToken()) return renderLogin()
  try {
    const { user } = await api.me()
    state.user = user
    renderApp()
  } catch {
    renderLogin()
  }
}

boot()
