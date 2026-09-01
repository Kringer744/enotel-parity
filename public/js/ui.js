/* Utilitários de interface: formatação pt-BR, toasts, selos. */

const dtf = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Recife'
})
const df = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC'
})

export const fmtDateTime = (v) => (v ? dtf.format(new Date(v)) : '—')
export const fmtDate = (v) => {
  if (!v) return '—'
  const iso = String(v).slice(0, 10)
  return df.format(new Date(`${iso}T12:00:00Z`))
}

export function fmtRelative (v) {
  if (!v) return 'nunca'
  const diff = (Date.now() - new Date(v).getTime()) / 1000
  if (diff < 60) return 'agora mesmo'
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`
  return `há ${Math.floor(diff / 86400)} d`
}

export const pct = (v, digits = 1) =>
  v === null || v === undefined ? '—' : `${Number(v).toFixed(digits).replace('.', ',')}%`

export const SEVERITY = {
  critical: { label: 'Crítico', icon: 'shield-alert' },
  serious: { label: 'Grave', icon: 'alert-triangle' },
  warning: { label: 'Atenção', icon: 'alert-circle' },
  info: { label: 'Info', icon: 'info' }
}

export const KIND = {
  undercut: 'OTA abaixo do direto',
  overcut: 'OTA acima do direto',
  missing_direct: 'Tarifa direta ausente',
  missing_channel: 'Canal sem oferta'
}

export function severityBadge (severity) {
  const s = SEVERITY[severity] || SEVERITY.info
  return `<span class="badge ${severity}"><i data-lucide="${s.icon}" class="icon-sm"></i>${s.label}</span>`
}

export function statusBadge (status) {
  const map = {
    ok: ['good', 'check-circle', 'Concluída'],
    partial: ['warning', 'alert-circle', 'Parcial'],
    failed: ['critical', 'x-circle', 'Falhou'],
    running: ['info', 'loader-2', 'Em andamento'],
    skipped: ['neutral', 'skip-forward', 'Pulada'],
    open: ['critical', 'alert-triangle', 'Aberto'],
    acknowledged: ['warning', 'eye', 'Ciente'],
    resolved: ['good', 'check', 'Resolvido'],
    sent: ['good', 'send', 'Enviada'],
    pending: ['neutral', 'clock', 'Pendente']
  }
  const [cls, icon, label] = map[status] || ['neutral', 'help-circle', status]
  return `<span class="badge ${cls}"><i data-lucide="${icon}" class="icon-sm"></i>${label}</span>`
}

export function escapeHtml (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/**
 * Substitui os <i data-lucide> por SVG. Precisa rodar DEPOIS de cada innerHTML.
 * O guard evita quebrar a tela inteira se o CDN do lucide nao carregar.
 */
export function refreshIcons (root = document.body) {
  try { window.lucide?.createIcons({ root }) } catch { /* CDN indisponivel */ }
}

let toastHost = null

export function toast (message, kind = 'info', ms = 4200) {
  if (!toastHost) {
    toastHost = document.createElement('div')
    toastHost.className = 'toast-host'
    document.body.appendChild(toastHost)
  }
  const icon = kind === 'error' ? 'x-circle' : kind === 'ok' ? 'check-circle' : 'info'
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.innerHTML = `<i data-lucide="${icon}" class="icon-sm"></i><span>${escapeHtml(message)}</span>`
  toastHost.appendChild(el)
  refreshIcons(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateX(20px)'
    el.style.transition = 'opacity .25s, transform .25s'
    setTimeout(() => el.remove(), 260)
  }, ms)
}

export function busy (btn, on, label = 'Aguarde...') {
  if (on) {
    btn._label = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = `<span class="spinner"></span>${label}`
  } else {
    btn.disabled = false
    if (btn._label) btn.innerHTML = btn._label
  }
}

export function skeleton (height = 200) {
  return `<div class="skeleton" style="height:${height}px"></div>`
}

/**
 * Bloco de carregamento com texto. Diz o que está acontecendo -- uma consulta
 * ao Google Hotels leva dezenas de segundos e o silêncio parece travamento.
 */
export function loading (text = 'Carregando dados...', height = 200) {
  return `<div class="loading-block" style="min-height:${height}px">
    <span class="spinner"></span>
    <span class="loading-text">${escapeHtml(text)}</span>
  </div>`
}

export function emptyState (icon, text) {
  return `<div class="empty"><i data-lucide="${icon}" class="empty-icon"></i>${escapeHtml(text)}</div>`
}
