const TOKEN_KEY = 'enotel.token'

export function getToken () {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function setToken (t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch {}
}

export class ApiError extends Error {
  constructor (message, status) {
    super(message)
    this.status = status
  }
}

async function request (path, { method = 'GET', body, raw = false } = {}) {
  const headers = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })

  if (res.status === 401) {
    setToken(null)
    window.dispatchEvent(new CustomEvent('auth:expired'))
    throw new ApiError('Sessão expirada', 401)
  }

  if (raw) {
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status)
    return res
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status)
  return data
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/auth/me'),

  overview: () => request('/overview'),
  trend: (days) => request(`/trend?days=${days}`),
  compliance: (days) => request(`/compliance?days=${days}`),
  heatmap: (days) => request(`/heatmap?days=${days}`),
  findings: (params = {}) => request(`/findings?${new URLSearchParams(params)}`),
  updateFinding: (id, status) => request(`/findings/${id}`, { method: 'PATCH', body: { status } }),
  currentRates: () => request('/rates/current'),
  report: (days) => request(`/report?days=${days}`),
  csvUrl: (days) => `/api/report/csv?days=${days}`,

  scans: (limit = 30) => request(`/scans?limit=${limit}`),
  runScan: () => request('/scans/run', { method: 'POST' }),
  budget: () => request('/budget'),
  budgetSync: () => request('/budget/sync', { method: 'POST' }),
  diagnose: (live = false) => request(`/serpapi/diagnose${live ? '?live=1' : ''}`),

  properties: () => request('/properties'),
  channels: () => request('/channels'),
  createTarget: (body) => request('/targets', { method: 'POST', body }),
  toggleTarget: (id, active) => request(`/targets/${id}`, { method: 'PATCH', body: { active } }),
  deleteTarget: (id) => request(`/targets/${id}`, { method: 'DELETE' }),

  waStatus: () => request('/whatsapp/status'),
  waInit: (name) => request('/whatsapp/instance', { method: 'POST', body: { name } }),
  waConnect: (phone) => request('/whatsapp/connect', { method: 'POST', body: { phone } }),
  waDisconnect: () => request('/whatsapp/disconnect', { method: 'POST' }),
  waContacts: (search = '') => request(`/whatsapp/contacts?search=${encodeURIComponent(search)}`),
  waRecipients: () => request('/whatsapp/recipients'),
  waAddRecipient: (body) => request('/whatsapp/recipients', { method: 'POST', body }),
  waToggleRecipient: (id, active) => request(`/whatsapp/recipients/${id}`, { method: 'PATCH', body: { active } }),
  waRemoveRecipient: (id) => request(`/whatsapp/recipients/${id}`, { method: 'DELETE' }),
  waTest: (to) => request('/whatsapp/test', { method: 'POST', body: { to } }),
  waNotifications: () => request('/whatsapp/notifications'),

  settings: () => request('/settings'),
  updateSettings: (key, body) => request(`/settings/${key}`, { method: 'PATCH', body })
}

// Baixa via fetch autenticado: o CSV está atrás do Bearer, um <a href> puro não passa.
export async function downloadCsv (days) {
  const res = await request(`/report/csv?days=${days}`, { raw: true })
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `paridade-enotel-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
