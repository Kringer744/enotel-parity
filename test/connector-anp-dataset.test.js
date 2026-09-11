import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { anpUrlFor, loadAnpCsv, clearAnpCache } from '../src/services/connectors/anp-dataset.js'

afterEach(() => clearAnpCache())

// fetch falso: devolve os bytes latin1 do texto dado e conta as chamadas.
function fakeFetch (text, box = { calls: 0 }) {
  return async () => {
    box.calls += 1
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(text, 'latin1') }
  }
}

test('anpUrlFor: mapeia UF -> regiao e compoe ca-ANO-SEM.csv', () => {
  const url = anpUrlFor('PE', { year: 2026, semester: 2 })
  assert.match(url, /ca-2026-02\.csv$/)
  assert.match(url, /^https:\/\/www\.gov\.br\/anp\//)
})

test('anpUrlFor: UF sem regiao mapeada lanca erro', () => {
  assert.throws(() => anpUrlFor('XX'), /sem regiao mapeada/)
})

test('loadAnpCsv: decodifica latin1 (acentos) - nao corrompe como utf-8', async () => {
  const text = await loadAnpCsv('SP', { fetchImpl: fakeFetch('Municipio;SÃO JOSÉ DOS CAMPOS'), year: 2026, semester: 1 })
  assert.match(text, /SÃO JOSÉ DOS CAMPOS/)
})

test('loadAnpCsv: cacheia ~7 dias por URL (fetch uma vez para duas leituras)', async () => {
  const box = { calls: 0 }
  const opts = { fetchImpl: fakeFetch('a;b', box), year: 2026, semester: 1 }
  await loadAnpCsv('RJ', opts)
  await loadAnpCsv('RJ', opts)
  assert.equal(box.calls, 1, 'segunda leitura veio do cache')
})

test('loadAnpCsv: force ignora o cache e rebaixa', async () => {
  const box = { calls: 0 }
  await loadAnpCsv('BA', { fetchImpl: fakeFetch('x', box), year: 2026, semester: 1 })
  await loadAnpCsv('BA', { fetchImpl: fakeFetch('x', box), year: 2026, semester: 1, force: true })
  assert.equal(box.calls, 2)
})

test('loadAnpCsv: HTTP != ok lanca erro claro com a UF', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 })
  await assert.rejects(() => loadAnpCsv('CE', { fetchImpl, year: 2026, semester: 1 }), /CE: HTTP 404/)
})
