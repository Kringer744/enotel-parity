import './helpers/env.js'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mockFetch, restoreFetch, calls } from './helpers/net.js'
import { getConnector, connectorForVertical, listConnectors } from '../src/services/connectors/index.js'
import { Connector } from '../src/services/connectors/base.js'
import { HotelSerpApiConnector } from '../src/services/connectors/hotel-serpapi.js'

// Conectores plugaveis (Radar/Cortex). O scanner fala SO com a interface do
// registry -> aqui provamos o contrato que ele consome, SEM banco: o conector
// recebe budget/credenciais por `ctx` (injecao), entao basta um ctx fake + fetch
// stub. Cobre tambem os bugs #1/#2/#3 pela camada do conector (novo home deles).

// ctx injetado pelo orquestrador: budget do tenant + credenciais do conector.
const ctx = () => ({
  credentials: { apiKey: 'test-key', endpoint: 'https://serpapi.com/search.json' },
  budget: {
    consume: async () => true,
    refund: async () => {},
    getUsage: async () => ({ used: 0, limit: 250, month: '2026-09' })
  },
  currency: 'BRL'
})
const searchCall = () => calls.find((u) => u.pathname.endsWith('search.json'))

beforeEach(() => { /* fetch instalado por teste */ })
afterEach(() => restoreFetch())

// ─── Registry ────────────────────────────────────────────────────────────────

test('registry: getConnector / connectorForVertical / listConnectors', () => {
  assert.equal(getConnector('hotel_serpapi')?.key, 'hotel_serpapi')
  assert.equal(getConnector('nao_existe'), null)
  const hotel = connectorForVertical('hotel')
  assert.ok(hotel)
  assert.equal(hotel.key, 'hotel_serpapi')
  assert.equal(hotel.vertical, 'hotel')
  assert.equal(connectorForVertical('vertical_inexistente'), null)
  assert.ok(listConnectors().some((c) => c.key === 'hotel_serpapi'))
})

test('interface base: Connector nao implementado falha alto (contrato)', async () => {
  const c = new Connector()
  assert.throws(() => c.key, /nao implementado/)
  assert.throws(() => c.vertical, /nao implementado/)
  await assert.rejects(() => c.discover({}, ctx()), /nao implementado/)
})

test('HotelSerpApiConnector: metadados e custo (costPerScan/costGroupKey)', () => {
  const c = new HotelSerpApiConnector()
  assert.equal(c.key, 'hotel_serpapi')
  assert.equal(c.vertical, 'hotel')
  assert.equal(c.metered, true)
  // 1 requisicao com handle em cache; 2 na 1a vez (descobre o token antes).
  assert.equal(c.costPerScan({ serp_property_token: 'T' }), 1)
  assert.equal(c.costPerScan({ serp_property_token: null }), 2)
  // Chave de grupo distinta por estadia/ocupacao (hotel nao agrupa buscas).
  const fixo = { mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-02', adults: 2, property_id: 1 }
  const k1 = c.costGroupKey(fixo)
  const k2 = c.costGroupKey({ ...fixo, adults: 4 })
  const kRoll = c.costGroupKey({ mode: 'rolling', horizon_days: 30, los: 2, adults: 2, property_id: 1 })
  assert.equal(typeof k1, 'string')
  assert.notEqual(k1, k2, 'ocupacao diferente -> grupo diferente')
  assert.notEqual(k1, kRoll, 'fixo e rolling nao compartilham grupo')
})

// ─── HotelSerpApiConnector via ctx fake + fetch stub (sem banco) ──────────────

test('#1/#2 discover: acha o handle (formato pagina do hotel) e nao usa ads', async () => {
  mockFetch(() => ({ body: { property_token: 'TOK_RAIZ', name: 'Enotel Resort' } }))
  const c = new HotelSerpApiConnector()
  const r = await c.discover({ serp_query: 'Enotel resort Ipojuca Pernambuco', los: 2, adults: 2 }, ctx())
  assert.equal(r.handle, 'TOK_RAIZ')
  assert.equal(r.name, 'Enotel Resort')
})

test('#1 discover: consulta zero-dados lanca erro (nao cai nos ads)', async () => {
  mockFetch(() => ({ body: { properties: [], ads: [{ property_token: 'AD', name: 'Outro' }] } }))
  const c = new HotelSerpApiConnector()
  await assert.rejects(() => c.discover({ serp_query: 'Enotel Porto de Galinhas', adults: 2 }, ctx()), /Nenhum hotel encontrado/)
})

test('#3 fetchOffers: envia `q` + property_token, normaliza e carimba a moeda', async () => {
  mockFetch(() => ({
    body: {
      name: 'Enotel',
      prices: [
        { source: 'Enotel Convention & Spa', official: true, rate_per_night: { extracted_lowest: 1000 } },
        { source: 'Booking.com', total_rate: { extracted_lowest: 1800 } } // 1800 / 2 noites = 900
      ]
    }
  }))
  const c = new HotelSerpApiConnector()
  const { offers, subjectName } = await c.fetchOffers({
    serp_property_token: 'TOK_ABC',
    serp_query: 'Enotel resort Ipojuca Pernambuco',
    mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-01', adults: 2, currency: 'BRL'
  }, ctx())

  const s = searchCall()
  assert.equal(s.searchParams.get('q'), 'Enotel resort Ipojuca Pernambuco', 'q obrigatorio junto do token')
  assert.equal(s.searchParams.get('property_token'), 'TOK_ABC')
  assert.equal(subjectName, 'Enotel')
  const enotel = offers.find((o) => o.official)
  const booking = offers.find((o) => /booking/i.test(o.source))
  assert.equal(enotel.price, 1000)
  assert.equal(booking.price, 900) // total_rate 1800 / 2 noites
  assert.equal(booking.currency, 'BRL', 'moeda carimbada pelo ctx')
})

test('fetchOffers sem handle -> erro (obriga discover primeiro)', async () => {
  mockFetch(() => ({ body: {} }))
  const c = new HotelSerpApiConnector()
  await assert.rejects(
    () => c.fetchOffers({ serp_query: 'Enotel', mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-02', adults: 2 }, ctx()),
    /discover primeiro/
  )
})
