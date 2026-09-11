import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAnpCsv, rowsToOffers, FuelConnector } from '../src/services/connectors/fuel-anp.js'
import { clearAnpCache } from '../src/services/connectors/anp-dataset.js'

// Fixture no formato real da ANP (por revenda): `;` separador, virgula decimal,
// data dd/mm/aaaa. Mesmo posto (CNPJ 111) aparece 2x -> fica a coleta mais recente.
const CSV = [
  'Regiao - Sigla;Estado - Sigla;Municipio;Revenda;CNPJ da Revenda;Nome da Rua;Numero Rua;Complemento;Bairro;Cep;Produto;Data da Coleta;Valor de Venda;Valor de Compra;Unidade de Medida;Bandeira',
  'NE;PE;IPOJUCA;POSTO ENOTEL LTDA;11.111.111/0001-11;AV BEIRA MAR;100;;PORTO;55590-000;GASOLINA;05/09/2026;5,79;5,10;R$ / litro;BRANCA',
  'NE;PE;IPOJUCA;POSTO ENOTEL LTDA;11.111.111/0001-11;AV BEIRA MAR;100;;PORTO;55590-000;GASOLINA;12/09/2026;5,89;5,12;R$ / litro;BRANCA',
  'NE;PE;IPOJUCA;POSTO VIZINHO SA;22.222.222/0001-22;RUA DAS FLORES;50;;CENTRO;55590-100;GASOLINA;12/09/2026;5,49;4,98;R$ / litro;IPIRANGA',
  'NE;PE;IPOJUCA;POSTO VIZINHO SA;22.222.222/0001-22;RUA DAS FLORES;50;;CENTRO;55590-100;ETANOL;12/09/2026;3,99;3,40;R$ / litro;IPIRANGA',
  'NE;PE;RECIFE;POSTO OUTRA CIDADE;33.333.333/0001-33;AV CAXANGA;900;;IPUTINGA;50000-000;GASOLINA;12/09/2026;6,10;5,30;R$ / litro;SHELL'
].join('\n')

test('parseAnpCsv: le colunas, normaliza numero (virgula) e CNPJ (so digitos)', () => {
  const rows = parseAnpCsv(CSV)
  assert.equal(rows.length, 5)
  const r = rows[0]
  assert.equal(r.municipio, 'IPOJUCA')
  assert.equal(r.uf, 'PE')
  assert.equal(r.cnpj, '11111111000111')
  assert.equal(r.produto, 'GASOLINA')
  assert.equal(r.valorVenda, 5.79)
  assert.equal(r.bandeira, 'BRANCA')
})

test('rowsToOffers: filtra municipio+produto, ancora por CNPJ, coleta mais recente', () => {
  const rows = parseAnpCsv(CSV)
  const offers = rowsToOffers(rows, {
    municipio: 'Ipojuca', produto: 'gasolina', ownCnpj: '11.111.111/0001-11'
  })
  // 2 postos em Ipojuca com gasolina (Recife fica de fora; etanol fica de fora)
  assert.equal(offers.length, 2)

  const proprio = offers.find((o) => o.official)
  const vizinho = offers.find((o) => !o.official)
  assert.ok(proprio, 'ancora casada pelo CNPJ do cliente')
  assert.equal(proprio.price, 5.89, 'ficou a coleta mais recente (12/09), nao a de 05/09')
  assert.equal(proprio.currency, 'BRL')
  assert.equal(vizinho.price, 5.49)
  assert.match(vizinho.source, /IPIRANGA/)
})

test('rowsToOffers: produto diferente nao vaza (etanol fora de uma busca de gasolina)', () => {
  const rows = parseAnpCsv(CSV)
  const offers = rowsToOffers(rows, { municipio: 'Ipojuca', produto: 'etanol' })
  assert.equal(offers.length, 1)
  assert.equal(offers[0].price, 3.99)
})

test('FuelConnector: identidade e modelo de custo (NAO-MEDIDO, agrupado por praca)', () => {
  const c = new FuelConnector()
  assert.equal(c.key, 'fuel_anp')
  assert.equal(c.vertical, 'fuel')
  assert.equal(c.metered, false, 'ANP nao tem cota dura')
  assert.equal(c.costPerScan({}), 0)
  // Mesma praca+produto -> mesmo grupo (N alvos = 1 download); produto diferente -> outro grupo.
  const g1 = c.costGroupKey({ params: { municipio: 'Ipojuca', uf: 'PE', produto: 'gasolina' } })
  const g2 = c.costGroupKey({ params: { municipio: 'Ipojuca', uf: 'PE', produto: 'gasolina' } })
  const g3 = c.costGroupKey({ params: { municipio: 'Ipojuca', uf: 'PE', produto: 'etanol' } })
  assert.equal(g1, g2)
  assert.notEqual(g1, g3)
})

test('FuelConnector: discover resolve a praca sem chamada externa', async () => {
  const c = new FuelConnector()
  const r = await c.discover({ params: { municipio: 'Ipojuca', uf: 'PE' } }, {})
  assert.equal(r.handle, 'ipojuca/pe')
  assert.match(r.name, /Ipojuca/)
})

test('FuelConnector: fetchOffers usa loader injetado via ctx.dataset (F3 pluga o real)', async () => {
  const c = new FuelConnector()
  const ctx = { currency: 'BRL', dataset: { loadAnpCsv: async () => CSV } }
  const { offers } = await c.fetchOffers(
    { params: { municipio: 'Ipojuca', uf: 'PE', produto: 'gasolina', own_cnpj: '11111111000111' } },
    ctx
  )
  assert.equal(offers.length, 2)
  assert.ok(offers.some((o) => o.official))
})

test('FuelConnector: sem ctx.dataset cai no loader de exemplo (anp-dataset via fetch)', async () => {
  const realFetch = globalThis.fetch
  clearAnpCache()
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(CSV, 'latin1') })
  try {
    const { offers } = await new FuelConnector().fetchOffers(
      { params: { municipio: 'Ipojuca', uf: 'PE', produto: 'gasolina', own_cnpj: '11111111000111' } },
      { currency: 'BRL' } // sem dataset injetado -> usa o loader default
    )
    assert.equal(offers.length, 2)
  } finally {
    globalThis.fetch = realFetch
    clearAnpCache()
  }
})

// Nota: o FuelConnector so entra no registry (connectors/index.js) na Fase 3,
// quando o download ao vivo do arquivo ANP estiver plugado -- registrar um
// esqueleto faria o sistema pensar que o vertical fuel esta pronto.
