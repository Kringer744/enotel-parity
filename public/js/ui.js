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
  critical: { label: 'Crítico', icon: '⛔' },
  serious: { label: 'Grave', icon: '⚠️' },
  warning: { label: 'Atenção', icon: '⚡' },
  info: { label: 'Info', icon: 'ℹ️' }
}

export const KIND = {
  undercut: 'OTA abaixo do direto',
  overcut: 'OTA acima do direto',
  missing_direct: 'Tarifa direta ausente',
  missing_channel: 'Canal sem oferta'
}

/** Selo de severidade — ícone + rótulo, nunca cor sozinha. */
export function severityBadge (severity) {
  const s = SEVERITY[severity] || SEVERITY.info
  return `<span class="badge ${severity}"><span aria-hidden="true">${s.icon}</span>${s.label}</span>`
}

export function statusBadge (status) {
  const map = {
    ok: ['good', '✓', 'Concluída'],
    partial: ['warning', '⚡', 'Parcial'],
    failed: ['critical', '✕', 'Falhou'],
    running: ['info', '↻', 'Em andamento'],
    skipped: ['neutral', '—', 'Pulada'],
    open: ['critical', '●', 'Aberto'],
    acknowledged: ['warning', '👁', 'Ciente'],
    resolved: ['good', '✓', 'Resolvido'],
    sent: ['good', '✓', 'Enviada'],
    pending: ['neutral', '○', 'Pendente']
  }
  const [cls, icon, label] = map[status] || ['neutral', '·', status]
  return `<span class="badge ${cls}"><span aria-hidden="true">${icon}</span>${label}</span>`
}

export function escapeHtml (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

let toastHost = null

export function toast (message, kind = 'info', ms = 4200) {
  if (!toastHost) {
    toastHost = document.createElement('div')
    toastHost.className = 'toast-host'
    document.body.appendChild(toastHost)
  }
  const icon = kind === 'error' ? '✕' : kind === 'ok' ? '✓' : 'ℹ'
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.innerHTML = `<span aria-hidden="true">${icon}</span><span>${escapeHtml(message)}</span>`
  toastHost.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateX(20px)'
    el.style.transition = 'opacity .25s, transform .25s'
    setTimeout(() => el.remove(), 260)
  }, ms)
}

/** Estado de carregamento em botão, restaurando o rótulo original ao fim. */
export function busy (btn, on, label = 'Aguarde…') {
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

export function emptyState (icon, text) {
  return `<div class="empty"><div class="empty-icon">${icon}</div>${escapeHtml(text)}</div>`
}
