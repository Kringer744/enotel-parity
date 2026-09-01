import { config } from '../config.js'
import * as budget from '../lib/budget.js'

class SerpApiError extends Error {
  constructor (message, { budgetExhausted = false } = {}) {
    super(message)
    this.name = 'SerpApiError'
    this.budgetExhausted = budgetExhausted
  }
}

/**
 * Toda chamada passa por aqui. Reserva a cota ANTES do fetch e devolve em caso
 * de falha de rede -- assim uma requisicao que nunca chegou a SerpAPI nao fica
 * contada contra o orcamento de 250.
 */
async function call (params, { allowReserve = false } = {}) {
  if (!config.serpapi.key) {
    throw new SerpApiError('SERPAPI_KEY nao configurada')
  }

  const ok = await budget.consume(1, { allowReserve })
  if (!ok) {
    const usage = await budget.getUsage()
    throw new SerpApiError(
      `Orcamento SerpAPI esgotado (${usage.used}/${usage.limit} em ${usage.month})`,
      { budgetExhausted: true }
    )
  }

  const url = new URL(config.serpapi.endpoint)
  for (const [k, v] of Object.entries({ ...params, api_key: config.serpapi.key })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }

  let res
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
  } catch (err) {
    // A requisicao nao chegou ao servidor: a SerpAPI nao vai cobrar por ela.
    await budget.refund(1)
    throw new SerpApiError(`Falha de rede na SerpAPI: ${err.message}`)
  }

  const body = await res.json().catch(() => null)

  if (!res.ok || body?.error) {
    const msg = body?.error || `HTTP ${res.status}`
    // 4xx de credencial/parametro tambem nao consome credito no lado da SerpAPI.
    if (res.status === 401 || res.status === 403) await budget.refund(1)
    throw new SerpApiError(`SerpAPI: ${msg}`)
  }
  return body
}

function fmtDate (d) {
  return d.toISOString().slice(0, 10)
}

export function datesForHorizon (horizonDays, los) {
  const checkIn = new Date()
  checkIn.setUTCHours(12, 0, 0, 0)
  checkIn.setUTCDate(checkIn.getUTCDate() + horizonDays)
  const checkOut = new Date(checkIn)
  checkOut.setUTCDate(checkOut.getUTCDate() + los)
  return { checkIn: fmtDate(checkIn), checkOut: fmtDate(checkOut) }
}

const BASE_PARAMS = {
  engine: 'google_hotels',
  gl: 'br',
  hl: 'pt-br',
  currency: 'BRL'
}

/**
 * Descobre o property_token do hotel. Roda UMA vez por propriedade -- o token e
 * cacheado no banco, senao cada varredura custaria o dobro de requisicoes.
 */
export async function findPropertyToken (serpQuery, { checkIn, checkOut, adults = 2 }, opts = {}) {
  const body = await call({
    ...BASE_PARAMS,
    q: serpQuery,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults
  }, opts)

  const candidates = [...(body.properties || []), ...(body.ads || [])]
  if (candidates.length === 0) {
    throw new SerpApiError(`Nenhum hotel encontrado para "${serpQuery}"`)
  }

  const wanted = serpQuery.toLowerCase()
  const exact = candidates.find((p) => (p.name || '').toLowerCase().includes(wanted))
  const chosen = exact || candidates[0]

  if (!chosen.property_token) {
    throw new SerpApiError(`Hotel "${chosen.name}" veio sem property_token`)
  }
  return { token: chosen.property_token, name: chosen.name }
}

// A SerpAPI expoe o preco em varios formatos conforme o anunciante.
function extractNightly (entry, los) {
  const perNight = entry?.rate_per_night
  const total = entry?.total_rate

  const n = perNight?.extracted_lowest ?? perNight?.extracted_before_taxes_fees
  if (Number.isFinite(n) && n > 0) return n

  const t = total?.extracted_lowest ?? total?.extracted_before_taxes_fees
  if (Number.isFinite(t) && t > 0 && los > 0) return Math.round((t / los) * 100) / 100

  // Ultimo recurso: string tipo "R$ 1.234" ou "R$1.234,56"
  const raw = perNight?.lowest || total?.lowest || entry?.price
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')
    const parsed = Number.parseFloat(cleaned)
    if (Number.isFinite(parsed) && parsed > 0) {
      const isTotal = !perNight?.lowest
      return isTotal && los > 0 ? Math.round((parsed / los) * 100) / 100 : parsed
    }
  }
  return null
}

/**
 * Busca as ofertas de todos os canais para uma data. Uma requisicao devolve
 * Booking, Expedia, Hoteis.com, Trip.com etc. de uma vez -- e por isso que o
 * orcamento de 250 chega para uma varredura diaria.
 */
export async function fetchOffers (propertyToken, q, { checkIn, checkOut, adults = 2, los = 1 }, opts = {}) {
  const body = await call({
    ...BASE_PARAMS,
    q,\n    property_token: propertyToken,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults
  }, opts)

  const entries = [...(body.featured_prices || []), ...(body.prices || [])]
  const offers = []
  const seen = new Set()

  for (const entry of entries) {
    const source = (entry.source || entry.name || '').trim()
    if (!source) continue
    const price = extractNightly(entry, los)
    if (price === null) continue

    // featured_prices e prices repetem anunciantes; a primeira ocorrencia
    // (featured) traz o dado mais completo.
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    offers.push({
      source,
      price,
      official: Boolean(entry.official),
      link: entry.link || null,
      raw: entry
    })
  }

  return {
    offers,
    propertyName: body.name || null,
    searchMetadata: body.search_metadata || null
  }
}

export { SerpApiError }
