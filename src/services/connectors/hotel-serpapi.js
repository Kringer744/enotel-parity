import { Connector } from './base.js'

/**
 * HotelSerpApiConnector -- fonte SerpAPI / Google Hotels.
 *
 * Logica extraida de `services/serpapi.js` SEM alteracao de comportamento: os 3
 * bugs historicos continuam travados (consulta que traz o hotel na LISTA, os dois
 * formatos de resposta, e `q` enviado junto do property_token). A unica mudanca e
 * a injecao de dependencia: credenciais e guarda de orcamento chegam via `ctx`, em
 * vez de `config` global + import direto de `budget`.
 *
 * As funcoes de nivel medio (discoverToken/fetchOffersFor/runProbe) sao exportadas
 * porque o adaptador de compatibilidade `services/serpapi.js` as reusa com um ctx
 * global default -- assim scanner.js e routes/index.js seguem funcionando sem edicao
 * enquanto o Cortex nao religa o scanner ao registry na passada de tenant.
 */

export class SerpApiError extends Error {
  constructor (message, { budgetExhausted = false } = {}) {
    super(message)
    this.name = 'SerpApiError'
    this.budgetExhausted = budgetExhausted
  }
}

const BASE_PARAMS = {
  engine: 'google_hotels',
  gl: 'br',
  hl: 'pt-br',
  currency: 'BRL'
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

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))

/**
 * Resolve as datas de um alvo conforme o modo. No modo 'fixed' o numero de noites
 * vem da propria diferenca entre as datas; no movel, de datesForHorizon.
 */
export function resolveDates (target) {
  if (target.mode === 'fixed') {
    const checkIn = iso(target.check_in)
    const checkOut = iso(target.check_out)
    const nights = Math.max(
      1,
      Math.round((new Date(`${checkOut}T12:00:00Z`) - new Date(`${checkIn}T12:00:00Z`)) / 86400000)
    )
    return { checkIn, checkOut, los: nights }
  }
  const d = datesForHorizon(target.horizon_days, target.los)
  return { checkIn: d.checkIn, checkOut: d.checkOut, los: target.los }
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
 * Toda chamada passa por aqui. Reserva a cota via `ctx.budget` ANTES do fetch e
 * estorna em caso de falha de rede ou 401/403 -- o estorno fica ONDE a falha e
 * detectada, porque so o conector sabe se a requisicao chegou a ser cobrada.
 */
async function call (params, ctx, { allowReserve = false } = {}) {
  const apiKey = ctx?.credentials?.apiKey
  if (!apiKey) {
    throw new SerpApiError('SERPAPI_KEY nao configurada')
  }

  const ok = await ctx.budget.consume(1, { allowReserve })
  if (!ok) {
    const usage = await ctx.budget.getUsage()
    throw new SerpApiError(
      `Orcamento SerpAPI esgotado (${usage.used}/${usage.limit} em ${usage.month})`,
      { budgetExhausted: true }
    )
  }

  const url = new URL(ctx.credentials.endpoint || 'https://serpapi.com/search.json')
  for (const [k, v] of Object.entries({ ...params, api_key: apiKey })) {
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
    await ctx.budget.refund(1)
    throw new SerpApiError(`Falha de rede na SerpAPI: ${err.message}`)
  }

  const body = await res.json().catch(() => null)

  if (!res.ok || body?.error) {
    const msg = body?.error || `HTTP ${res.status}`
    // 4xx de credencial/parametro tambem nao consome credito no lado da SerpAPI.
    if (res.status === 401 || res.status === 403) await ctx.budget.refund(1)
    throw new SerpApiError(`SerpAPI: ${msg}`)
  }
  return body
}

/**
 * Descobre o property_token do hotel. Roda UMA vez por propriedade -- o handle e
 * cacheado no subject pelo orquestrador (esta funcao NAO escreve no banco).
 *
 * BUG HISTORICO 1 e 2: a consulta precisa trazer o hotel na LISTA, e a resposta
 * vem em dois formatos (pagina do hotel com token na raiz, ou lista). `ads[]` sao
 * anuncios de OUTROS hoteis -- nunca usar.
 */
export async function discoverToken (serpQuery, { checkIn, checkOut, adults = 2 }, ctx, opts = {}) {
  const body = await call({
    ...BASE_PARAMS,
    q: serpQuery,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults
  }, ctx, opts)

  // Quando a consulta identifica um unico hotel, o Google Hotels responde com a
  // PAGINA DO HOTEL: property_token vem na raiz e nao existe `properties`.
  // Consultas mais amplas devolvem a lista. Os dois formatos sao validos.
  if (body.property_token) {
    return { token: body.property_token, name: body.name || serpQuery, shape: 'detail' }
  }

  const candidates = body.properties || []
  if (candidates.length === 0) {
    // `ads` sao anuncios de OUTROS hoteis -- usa-los daria o hotel errado.
    throw new SerpApiError(
      `Nenhum hotel encontrado para "${serpQuery}". ` +
      'Use uma consulta que traga o hotel na lista (ex.: incluir cidade e estado).'
    )
  }

  // Casa pelo maior numero de palavras da consulta presentes no nome, para nao
  // pegar um vizinho so porque veio primeiro.
  const words = serpQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  let best = null
  let bestScore = 0
  for (const p of candidates) {
    const name = (p.name || '').toLowerCase()
    const score = words.reduce((n, w) => n + (name.includes(w) ? 1 : 0), 0)
    if (score > bestScore) { best = p; bestScore = score }
  }

  const chosen = best || candidates[0]
  if (!chosen.property_token) {
    throw new SerpApiError(`Hotel "${chosen.name}" veio sem property_token`)
  }
  return { token: chosen.property_token, name: chosen.name, shape: 'list' }
}

/**
 * Busca as ofertas de todos os canais para uma data. Uma requisicao devolve
 * Booking, Expedia, Hoteis.com, Trip.com etc. de uma vez.
 *
 * BUG HISTORICO 3: `q` VAI JUNTO do property_token -- sem `q` a SerpAPI responde
 * `Missing query 'q' parameter`.
 *
 * Dedup por STRING `source` (primeira ocorrencia vence): featured_prices vem ANTES
 * de prices de proposito, porque a primeira ocorrencia traz o dado mais completo.
 * (O dedup por CANAL/menor-tarifa e outra camada, e vive no scanner.)
 */
export async function fetchOffersFor (propertyToken, q, { checkIn, checkOut, adults = 2, los = 1 }, ctx, opts = {}) {
  const body = await call({
    ...BASE_PARAMS,
    q,
    property_token: propertyToken,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults
  }, ctx, opts)

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

/**
 * Busca de diagnostico: devolve as ofertas cruas de um alvo, sem gravar nada.
 * Default `allowReserve:true` -- o diagnostico pode usar a reserva de emergencia,
 * senao o `?live=1` falha perto do teto.
 */
export async function runProbe (target, ctx, opts = { allowReserve: true }) {
  const dates = resolveDates(target)
  const nights = dates.los
  let token = target.serp_property_token
  let requestsUsed = 0

  if (!token) {
    const found = await discoverToken(target.serp_query, {
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
      adults: target.adults
    }, ctx, opts)
    token = found.token
    requestsUsed += 1
  }

  const { offers, propertyName } = await fetchOffersFor(token, target.serp_query, {
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults: target.adults,
    los: nights
  }, ctx, opts)
  requestsUsed += 1

  return {
    target: target.label,
    query: target.serp_query,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    propertyName,
    tokenWasCached: Boolean(target.serp_property_token),
    requestsUsed,
    offers
  }
}

export class HotelSerpApiConnector extends Connector {
  get key () { return 'hotel_serpapi' }
  get vertical () { return 'hotel' }
  get metered () { return true }

  /**
   * O property_token independe da data, entao a descoberta usa uma janela neutra
   * futura. NAO persiste o handle -- quem cacheia no subject e o orquestrador.
   */
  async discover (subject, ctx) {
    const dates = datesForHorizon(30, subject.los ?? 2)
    const found = await discoverToken(subject.serp_query, {
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
      adults: subject.adults ?? 2
    }, ctx, { allowReserve: Boolean(ctx?.allowReserve) })
    return { handle: found.token, name: found.name }
  }

  async fetchOffers (target, ctx) {
    if (!target.serp_property_token) {
      throw new SerpApiError('fetchOffers requer o handle do subject; chame discover primeiro')
    }
    const dates = resolveDates(target)
    const { offers, propertyName } = await fetchOffersFor(target.serp_property_token, target.serp_query, {
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
      adults: target.adults,
      los: dates.los
    }, ctx, { allowReserve: Boolean(ctx?.allowReserve) })

    const currency = ctx?.currency ?? target.currency ?? 'BRL'
    return {
      offers: offers.map((o) => ({ ...o, currency })),
      subjectName: propertyName
    }
  }

  async probe (target, ctx) {
    // Diagnostico mantem o default allowReserve:true (o ?live=1 perto do teto),
    // mas honra um ctx.allowReserve explicito quando o orquestrador o define.
    const { offers, ...meta } = await runProbe(target, ctx, { allowReserve: ctx?.allowReserve ?? true })
    return { offers, meta }
  }

  /** 1 requisicao de ofertas por varredura; +1 na 1a vez, se nao ha handle. */
  costPerScan (target) {
    return target.serp_property_token ? 1 : 2
  }

  /** Hotel: cada alvo e uma busca upstream propria (data/ocupacao distintas). */
  costGroupKey (target) {
    const win = target.mode === 'fixed'
      ? `${iso(target.check_in)}:${iso(target.check_out)}`
      : `roll${target.horizon_days}:${target.los}`
    const subjectKey = target.property_id ?? target.subject_id ?? target.serp_query
    return `${subjectKey}:${win}:${target.adults}`
  }
}
