import './helpers/env.js'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mockFetch, mockFetchNetworkError, restoreFetch, calls } from './helpers/net.js'
import { HotelSerpApiConnector, resolveDates } from '../src/services/connectors/hotel-serpapi.js'
import { getConnector, connectorForVertical } from '../src/services/connectors/index.js'

// Guarda de orcamento FALSA injetada via ctx: libera sempre e conta o saldo, para
// provar o consume/refund sem tocar em banco/rede real.
function okBudget () {
  return {
    consumed: 0,
    lastAllowReserve: undefined,
    async consume (n = 1, { allowReserve = false } = {}) { this.consumed += 1; this.lastAllowReserve = allowReserve; return true },
    async refund () { this.consumed -= 1 },
    async getUsage () { return { used: 0, limit: 250, month: '2026-09' } }
  }
}

const ctx = (budget = okBudget()) => ({
  credentials: { apiKey: 'k', endpoint: 'https://serpapi.com/search.json' },
  budget,
  currency: 'BRL'
})

const searchCall = () => calls.find((u) => u.pathname.endsWith('search.json'))

afterEach(() => restoreFetch())

test('discover: devolve {handle,name} (nao escreve no banco, so busca)', async () => {
  mockFetch(() => ({ body: { property_token: 'TOKEN_RAIZ', name: 'Enotel Resort' } }))
  const r = await new HotelSerpApiConnector().discover(
    { serp_query: 'Enotel resort Ipojuca Pernambuco' }, ctx()
  )
  assert.equal(r.handle, 'TOKEN_RAIZ')
  assert.equal(r.name, 'Enotel Resort')
})

test('fetchOffers: manda `q` junto do property_token e carimba currency no Offer', async () => {
  mockFetch(() => ({ body: { name: 'Enotel', prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: 900 } }] } }))
  const { offers, subjectName } = await new HotelSerpApiConnector().fetchOffers({
    mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-01',
    adults: 2, serp_query: 'Enotel resort Ipojuca Pernambuco', serp_property_token: 'T'
  }, ctx())
  const s = searchCall()
  assert.equal(s.searchParams.get('q'), 'Enotel resort Ipojuca Pernambuco', 'q obrigatorio')
  assert.equal(s.searchParams.get('property_token'), 'T')
  assert.equal(offers.length, 1)
  assert.equal(offers[0].currency, 'BRL', 'conector carimba currency')
  assert.equal(subjectName, 'Enotel')
})

test('fetchOffers: los vem das datas do alvo e normaliza total_rate em diaria media', async () => {
  // fixed 2026-12-30 -> 2027-01-02 = 3 noites; total_rate 3000 -> diaria 1000.
  // Trava o ponto de verificacao do Cortex: o los que o conector calcula internamente
  // = o do resolveDates do scanner (senao a normalizacao da diaria mudaria).
  mockFetch(() => ({ body: { name: 'Enotel', prices: [{ source: 'Booking.com', total_rate: { extracted_lowest: 3000 } }] } }))
  const { offers } = await new HotelSerpApiConnector().fetchOffers({
    mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-02',
    adults: 2, serp_query: 'Enotel', serp_property_token: 'T'
  }, ctx())
  assert.equal(offers[0].price, 1000)
})

test('resolveDates: fixed = noites entre datas; rolling = target.los (o scanner espelha p/ o rate row)', () => {
  const fixed = resolveDates({ mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-02' })
  assert.equal(fixed.checkIn, '2026-12-30')
  assert.equal(fixed.checkOut, '2027-01-02')
  assert.equal(fixed.los, 3)

  const rolling = resolveDates({ mode: 'rolling', horizon_days: 30, los: 2 })
  assert.equal(rolling.los, 2)
  const nights = Math.round((new Date(`${rolling.checkOut}T12:00:00Z`) - new Date(`${rolling.checkIn}T12:00:00Z`)) / 86400000)
  assert.equal(nights, 2)
})

test('fetchOffers: sem handle exige discover antes (nao adivinha token)', async () => {
  await assert.rejects(
    () => new HotelSerpApiConnector().fetchOffers({
      mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-01',
      adults: 2, serp_query: 'X', serp_property_token: null
    }, ctx()),
    /requer o handle/
  )
})

test('probe: devolve {offers, meta} com requestsUsed e tokenWasCached', async () => {
  mockFetch(() => ({ body: { name: 'Enotel', prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: 900 } }] } }))
  const { offers, meta } = await new HotelSerpApiConnector().probe({
    mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-01', adults: 2,
    serp_query: 'Enotel', serp_property_token: 'CACHED', label: 'Reveillon'
  }, ctx())
  assert.equal(offers.length, 1)
  assert.equal(meta.tokenWasCached, true)
  assert.equal(meta.requestsUsed, 1)
})

test('costPerScan: 1 com handle cacheado, 2 sem (precisa descobrir)', () => {
  const c = new HotelSerpApiConnector()
  assert.equal(c.costPerScan({ serp_property_token: 'T' }), 1)
  assert.equal(c.costPerScan({ serp_property_token: null }), 2)
})

test('costGroupKey: hotel = chave unica por alvo (datas distintas = grupos distintos)', () => {
  const c = new HotelSerpApiConnector()
  const a = c.costGroupKey({ property_id: 1, mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-01', adults: 2 })
  const b = c.costGroupKey({ property_id: 1, mode: 'fixed', check_in: '2026-12-31', check_out: '2027-01-02', adults: 2 })
  assert.notEqual(a, b)
})

test('metered: hotel e conector MEDIDO (passa pela guarda atomica)', () => {
  assert.equal(new HotelSerpApiConnector().metered, true)
})

test('ctx.allowReserve chega ate a guarda de orcamento (disparo manual usa a reserva)', async () => {
  mockFetch(() => ({ body: { name: 'Enotel', prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: 900 } }] } }))
  const b = okBudget()
  await new HotelSerpApiConnector().fetchOffers({
    mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-01',
    adults: 2, serp_query: 'X', serp_property_token: 'T'
  }, { credentials: { apiKey: 'k' }, budget: b, currency: 'BRL', allowReserve: true })
  assert.equal(b.lastAllowReserve, true)
})

test('estorno: falha de rede devolve a cota reservada via ctx.budget.refund', async () => {
  const b = okBudget()
  mockFetchNetworkError('ECONNREFUSED')
  await assert.rejects(
    () => new HotelSerpApiConnector().fetchOffers({
      mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-01',
      adults: 2, serp_query: 'X', serp_property_token: 'T'
    }, ctx(b)),
    /Falha de rede/
  )
  assert.equal(b.consumed, 0, 'reservou 1 e estornou 1')
})

test('registry: resolve por key e por vertical', () => {
  assert.equal(getConnector('hotel_serpapi')?.key, 'hotel_serpapi')
  assert.equal(connectorForVertical('hotel')?.key, 'hotel_serpapi')
  assert.equal(getConnector('inexistente'), null)
})
