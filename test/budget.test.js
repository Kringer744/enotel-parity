import './helpers/env.js'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mockQuery, restoreQuery } from './helpers/db.js'
import { mockFetch, mockFetchNetworkError, restoreFetch, isAccountUrl, accountBody } from './helpers/net.js'
import * as budget from '../src/lib/budget.js'

// localUsed() faz SELECT used FROM api_usage. Controla o valor local por teste.
let localValue = 0
function withLocal (n) {
  localValue = n
  mockQuery((sql) =>
    /SELECT used FROM api_usage/i.test(sql) ? { rows: [{ used: localValue }] } : { rows: [] }
  )
}

afterEach(() => {
  restoreQuery()
  restoreFetch()
})

test('currentMonth: formato YYYY-MM em UTC', () => {
  assert.equal(budget.currentMonth(new Date('2026-09-11T00:00:00Z')), '2026-09')
  assert.equal(budget.currentMonth(new Date('2026-01-05T00:00:00Z')), '2026-01')
})

// ORDEM IMPORTA: o "conta indisponivel" roda antes para o cache de conta ficar
// sem dados, forcando o teste seguinte a buscar de verdade.
test('getUsage: conta SerpAPI indisponivel -> cai no contador local', async () => {
  withLocal(40)
  mockFetchNetworkError('sem rede')
  const u = await budget.getUsage()
  assert.equal(u.live, false)
  assert.equal(u.used, 40)
  assert.equal(u.providerUsage, null)
  assert.ok(u.liveError)
})

test('getUsage: credito reflete a CONTA real (nao o contador local zerado)', async () => {
  // Este era o bug: o contador era local e comecava do zero, nunca olhava a
  // conta. Com o saldo real em 96 e o local em 0, o exibido deve ser 96.
  withLocal(0)
  mockFetch((url) => (isAccountUrl(url)
    ? { body: accountBody({ this_month_usage: 96, total_searches_left: 154 }) }
    : { body: {} }))
  const u = await budget.getUsage()
  assert.equal(u.live, true)
  assert.equal(u.used, 96, 'usa o max(real, local) = 96, nao 0')
  assert.equal(u.providerUsage, 96)
  assert.equal(u.localUsed, 0)
  assert.equal(u.limit, 250)
  assert.equal(u.remaining, 154)
  assert.equal(u.pctUsed, 38.4)
})
