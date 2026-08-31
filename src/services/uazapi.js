import { config } from '../config.js'
import { getSettings, updateSetting } from './settings.js'

/**
 * Cliente uazapi (WhatsApp).
 *
 * Fluxo: criar instancia -> conectar via QR -> escolher o contato que recebe os
 * alertas -> enviar. O token da instancia e persistido em settings.whatsapp para
 * sobreviver a redeploys; a env UAZAPI_INSTANCE_TOKEN tem precedencia quando
 * definida (util para fixar uma instancia ja existente).
 */

class UazapiError extends Error {
  constructor (message, status) {
    super(message)
    this.name = 'UazapiError'
    this.status = status
  }
}

export async function instanceToken () {
  if (config.uazapi.instanceToken) return config.uazapi.instanceToken
  const s = await getSettings()
  return s.whatsapp.instance_token || null
}

export function isConfigured () {
  return Boolean(config.uazapi.url)
}

async function request (path, { method = 'GET', body, token, admin = false } = {}) {
  if (!config.uazapi.url) {
    throw new UazapiError('UAZAPI_URL nao configurada', 500)
  }

  const headers = { 'Content-Type': 'application/json' }
  if (admin) {
    if (!config.uazapi.adminToken) {
      throw new UazapiError('UAZAPI_ADMIN_TOKEN nao configurado', 500)
    }
    headers.admintoken = config.uazapi.adminToken
  } else {
    const t = token || (await instanceToken())
    if (!t) throw new UazapiError('Instancia do WhatsApp ainda nao foi criada', 409)
    headers.token = t
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)

  let res
  try {
    res = await fetch(`${config.uazapi.url}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
  } catch (err) {
    throw new UazapiError(`Falha de rede ao falar com a uazapi: ${err.message}`, 502)
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }

  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`
    throw new UazapiError(`uazapi: ${msg}`, res.status)
  }
  return data
}

/** Cria a instancia (ou devolve a existente) e persiste o token. */
export async function initInstance (name = 'enotel-paridade') {
  const existing = await instanceToken()
  if (existing) {
    const status = await getStatus().catch(() => null)
    if (status) return { reused: true, ...status }
  }

  const data = await request('/instance/init', {
    method: 'POST',
    admin: true,
    body: { name }
  })

  const token = data?.instance?.token || data?.token
  if (!token) throw new UazapiError('uazapi nao devolveu o token da instancia', 502)

  await updateSetting('whatsapp', { instance_token: token, instance_name: name })
  return { reused: false, token, instance: data?.instance || null }
}

export async function getStatus () {
  const data = await request('/instance/status')
  const inst = data?.instance || data || {}
  const status = inst.status || data?.status || 'unknown'
  return {
    status,
    connected: status === 'connected' || status === 'open',
    number: inst.owner || inst.wid || inst.phone || null,
    profileName: inst.profileName || inst.name || null,
    raw: inst
  }
}

/** Gera o QR code para parear o aparelho. Devolve base64 pronto para <img>. */
export async function connect ({ phone } = {}) {
  const data = await request('/instance/connect', {
    method: 'POST',
    body: phone ? { phone } : {}
  })
  const inst = data?.instance || data || {}
  const qr = inst.qrcode || data?.qrcode || null
  return {
    status: inst.status || 'connecting',
    // A uazapi as vezes devolve com prefixo data:, as vezes so o base64.
    qrcode: qr && !String(qr).startsWith('data:') ? `data:image/png;base64,${qr}` : qr,
    paircode: inst.paircode || data?.paircode || null,
    raw: inst
  }
}

export async function disconnect () {
  return request('/instance/disconnect', { method: 'POST' })
}

function normalizePhone (raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  return digits || null
}

/** Lista conversas/contatos para o usuario escolher quem recebe os alertas. */
export async function listContacts ({ limit = 200, search = '' } = {}) {
  const data = await request('/chat/find', {
    method: 'POST',
    body: {
      operator: 'AND',
      sort: '-wa_lastMsgTimestamp',
      limit,
      offset: 0
    }
  })

  const rows = Array.isArray(data) ? data : (data?.chats || data?.data || [])
  const term = search.toLowerCase().trim()

  return rows
    .map((c) => {
      const jid = c.wa_chatid || c.id || c.jid || ''
      const isGroup = Boolean(c.wa_isGroup) || jid.endsWith('@g.us')
      const name =
        c.wa_contactName || c.lead_name || c.wa_name || c.name || c.pushName || null
      return {
        jid,
        name: name || normalizePhone(jid) || jid,
        phone: isGroup ? null : normalizePhone(jid.split('@')[0]),
        isGroup,
        image: c.image || c.wa_profilePicUrl || null
      }
    })
    .filter((c) => c.jid)
    .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.phone || '').includes(term))
}

/** Envia texto. `to` aceita numero E.164 sem '+' ou um JID completo. */
export async function sendText (to, text) {
  const number = to.includes('@') ? to : normalizePhone(to)
  if (!number) throw new UazapiError('Numero de destino invalido', 400)

  return request('/send/text', {
    method: 'POST',
    body: { number, text, linkPreview: false }
  })
}

export { UazapiError }
