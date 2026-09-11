import { api, getToken, setToken } from './api.js'
import { escapeHtml, busy, refreshIcons, emptyState } from './ui.js'
import { state } from './core/state.js'
import { pageDashboard } from './pages/dashboard.js'
import { pageRates } from './pages/rates.js'
import { pageFindings } from './pages/findings.js'
import { pageReport } from './pages/report.js'
import { pageWhatsApp } from './pages/whatsapp.js'
import { pageSettings } from './pages/settings.js'

const root = document.getElementById('root')

const NAV = [
  { id: 'dashboard', icon: 'layout-dashboard', label: 'Painel' },
  { id: 'rates', icon: 'tags', label: 'Tarifas atuais' },
  { id: 'findings', icon: 'alert-triangle', label: 'Violações', badge: true },
  { id: 'report', icon: 'file-bar-chart', label: 'Relatório' },
  { id: 'whatsapp', icon: 'message-circle', label: 'WhatsApp' },
  { id: 'settings', icon: 'settings', label: 'Configurações' }
]

/* ═══ Login ═══════════════════════════════════════════════════════════════ */

function renderLogin (message = '') {
  root.innerHTML = `
    <div class="login-shell">
      <form class="login-card" id="login-form">
        <div class="login-mark"><i data-lucide="shield-check" class="icon-lg"></i></div>
        <h1 style="font-size:22px">Paridade Enotel</h1>
        <p class="page-sub" style="margin-bottom:26px">
          Monitoramento de preços nos principais canais de venda
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

  refreshIcons(root)

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
  refreshIcons()
  go(state.page)
}

function renderNav () {
  const nav = document.getElementById('nav')
  if (!nav) return
  nav.innerHTML = NAV.map((n) => `
    <button class="nav-item ${state.page === n.id ? 'active' : ''}" data-page="${n.id}">
      <i data-lucide="${n.icon}" class="nav-icon"></i>
      <span>${n.label}</span>
      ${n.badge && state.openCount > 0 ? `<span class="nav-badge">${state.openCount}</span>` : ''}
    </button>`).join('')

  nav.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.page)))

  refreshIcons(nav)
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
      main.innerHTML = `<div class="card">${emptyState('info', `Não foi possível carregar: ${err.message}`)}</div>`
    }
  }
  // Cada página monta o HTML por innerHTML, então os ícones só viram SVG aqui.
  refreshIcons(main)
}

/* ═══ Boot ════════════════════════════════════════════════════════════════ */

window.addEventListener('auth:expired', () => renderLogin('Sua sessão expirou. Entre novamente.'))
window.addEventListener('navigate', (e) => go(e.detail))
window.addEventListener('nav:refresh', () => renderNav())

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

