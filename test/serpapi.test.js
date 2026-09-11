import './helpers/env.js'
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mockQuery, restoreQuery } from './helpers/db.js'
import { mockFetch, restoreFetch, calls, isAccountUrl, accountBody } from './helpers/net.js'
import * as serp from '../src/services/serpapi.js'

// A camada de orcamento reserva a cota via INSERT ... RETURNING used antes de
// cada fetch. O stub libera sempre (used baixo).
beforeEach(() => {
  mockQuery((sql) =>
    /INSERT INTO api_usage/i.test(sql) ? { rows: [{ used: 1 }] } : { rows: [] }
  )
})
afterEach(() => {
  restoreQuery()
  restoreFetch()
})

const searchCall = () => calls.find((u) => u.pathname.endsWith('search.json'))
// Roteia /account (saldo) vs /search.json (a busca de verdade).
const route = (searchBody) => (url) =>
  isAccountUrl(url) ? { body: accountBody() } : { body: searchBody }

test('findPropertyToken: formato PAGINA DO HOTEL (token na raiz, sem properties)', async () => {
  mockFetch(route({ property_token: 'TOKEN_RAIZ', name: 'Enotel Resort' }))
  const r = await serp.findPropertyToken(
    'Enotel resort Ipojuca Pernambuco',
    { checkIn: '2026-09-20', checkOut: '2026-09-22', adults: 2 }
  )
  assert.equal(r.token, 'TOKEN_RAIZ')
  assert.equal(r.shape, 'detail')
  assert.equal(r.name, 'Enotel Resort')
})

test('findPropertyToken: formato LISTA escolhe pelo maior numero de palavras da consulta', async () => {
  mockFetch(route({
    properties: [
      { name: 'Pousada Vizinha Ipojuca', property_token: 'VIZINHA' },
      { name: 'Enotel Resort Ipojuca Pernambuco', property_token: 'CERTO' }
    ],
    // ads sao anuncios de OUTROS hoteis e NAO podem ser usados
    ads: [{ name: 'Hotel Anuncio', property_token: 'ANUNCIO' }]
  }))
  const r = await serp.findPropertyToken(
    'Enotel resort Ipojuca Pernambuco',
    { checkIn: '2026-09-20', checkOut: '2026-09-22', adults: 2 }
  )
  assert.equal(r.token, 'CERTO')
  assert.equal(r.shape, 'list')
})

test('findPropertyToken: consulta zero-dados lanca erro e NAO cai nos ads', async () => {
  // Reproduz a "consulta zero-dados": properties vazio (a query errada), com ads
  // presentes -- usar o ad daria o hotel errado.
  mockFetch(route({ properties: [], ads: [{ name: 'Outro Hotel', property_token: 'AD' }] }))
  await assert.rejects(
    () => serp.findPropertyToken('Enotel Porto de Galinhas', { checkIn: '2026-09-20', checkOut: '2026-09-22' }),
    /Nenhum hotel encontrado/
  )
})

test('fetchOffers: envia `q` JUNTO do property_token (sem q a SerpAPI devolve Missing query)', async () => {
  mockFetch(route({
    name: 'Enotel',
    prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: 900 } }]
  }))
  const { offers } = await serp.fetchOffers(
    'TOKEN_ABC',
    'Enotel resort Ipojuca Pernambuco',
    { checkIn: '2026-09-20', checkOut: '2026-09-22', adults: 2, los: 2 }
  )
  const s = searchCall()
  assert.equal(s.searchParams.get('q'), 'Enotel resort Ipojuca Pernambuco', 'q obrigatorio')
  assert.equal(s.searchParams.get('property_token'), 'TOKEN_ABC')
  assert.equal(offers.length, 1)
  assert.equal(offers[0].price, 900)
})

test('fetchOffers: usa flag official, normaliza total_rate/noites e deduplica canal repetido', async () => {
  mockFetch(route({
    name: 'Enotel',
    prices: [
      { source: 'Enotel Convention & Spa', official: true, rate_per_night: { extracted_lowest: 1000 } },
      { source: 'Booking.com', total_rate: { extracted_lowest: 1800 } }, // 1800/2 noites = 900
      { source: 'Booking.com', rate_per_night: { extracted_lowest: 950 } } // duplicado: ignorado
    ]
  }))
  const { offers } = await serp.fetchOffers('T', 'Enotel', { checkIn: '2026-09-20', checkOut: '2026-09-22', los: 2 })
  assert.equal(offers.length, 2)
  const enotel = offers.find((o) => o.official)
  const booking = offers.find((o) => /booking/i.test(o.source))
  assert.equal(enotel.price, 1000)
  assert.equal(booking.price, 900) // veio de total_rate normalizado, primeira ocorrencia
})

test('probe: alvo de DATA FIXA usa as proprias datas, nao datesForHorizon', async () => {
  mockFetch(route({
    name: 'Enotel',
    prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: 900 } }]
  }))
  const target = {
    mode: 'fixed',
    check_in: '2026-12-30',
    check_out: '2027-01-02',
    adults: 2,
    serp_query: 'Enotel resort Ipojuca Pernambuco',
    serp_property_token: 'CACHED',
    label: 'Reveillon'
  }
  const r = await serp.probe(target)
  assert.equal(r.checkIn, '2026-12-30')
  assert.equal(r.checkOut, '2027-01-02')
  assert.equal(r.tokenWasCached, true)
  assert.equal(r.requestsUsed, 1) // token em cache: so a busca de ofertas
  assert.equal(searchCall().searchParams.get('check_in_date'), '2026-12-30')
})

test('probe: alvo rolling calcula datas a partir de hoje (datesForHorizon)', async () => {
  mockFetch(route({ name: 'Enotel', prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: 900 } }] }))
  const target = {
    mode: 'rolling', horizon_days: 7, los: 2, adults: 2,
    serp_query: 'Enotel', serp_property_token: 'CACHED', label: 'Curto prazo'
  }
  const esperado = serp.datesForHorizon(7, 2)
  const r = await serp.probe(target)
  assert.equal(r.checkIn, esperado.checkIn)
  assert.equal(r.checkOut, esperado.checkOut)
})

test('probe: sem token em cache descobre o token (gasta 2 requisicoes)', async () => {
  // Distingue as duas buscas pelo parametro property_token.
  mockFetch((url) => {
    if (isAccountUrl(url)) return { body: accountBody() }
    if (url.searchParams.has('property_token')) {
      return { body: { name: 'Enotel', prices: [{ source: 'Booking.com', rate_per_night: { extracted_lowest: 900 } }] } }
    }
    return { body: { property_token: 'DESCOBERTO', name: 'Enotel Resort' } }
  })
  const target = {
    mode: 'fixed', check_in: '2026-12-30', check_out: '2027-01-02', adults: 2,
    serp_query: 'Enotel resort Ipojuca Pernambuco', serp_property_token: null, label: 'Reveillon'
  }
  const r = await serp.probe(target)
  assert.equal(r.tokenWasCached, false)
  assert.equal(r.requestsUsed, 2)
})

test('datesForHorizon: janela movel de N dias com LOS noites', () => {
  const { checkIn, checkOut } = serp.datesForHorizon(30, 2)
  assert.match(checkIn, /^\d{4}-\d{2}-\d{2}$/)
  const nights = Math.round((new Date(`${checkOut}T12:00:00Z`) - new Date(`${checkIn}T12:00:00Z`)) / 86400000)
  assert.equal(nights, 2)
})
