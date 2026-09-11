import { Connector } from './base.js'

/**
 * FuelConnector (ANP) -- ESQUELETO da Fase 3.
 *
 * Fonte recomendada em Downloads/FONTE-COMBUSTIVEL.md: ANP Serie Historica de
 * Precos por REVENDA (posto). Gratuita, nacional, oficial, por posto com bandeira
 * e CNPJ, CSV semanal, SEM cota dura (`metered = false`).
 *
 * Modelo de custo (RFC 8.1): conector NAO-MEDIDO. Nao passa pela guarda atomica de
 * SerpAPI; o custo real e 1 download por praca/semana, COMPARTILHADO entre todos os
 * alvos do mesmo municipio+produto (ver `costGroupKey`). So alimenta o forecast.
 *
 * O que JA esta implementado aqui (nucleo testavel):
 *   - parseAnpCsv:  le o CSV por revenda da ANP (`;`, latin1, decimal virgula).
 *   - rowsToOffers: filtra por municipio+produto e mapeia para Offer[]; a ancora
 *                   (`official`) e o posto do proprio cliente, casado por CNPJ.
 * O que fica para a Fase 3 (unica parte que fala com a rede):
 *   - _loadRows:    baixar o arquivo da praca (dados-abertos ANP), cache ~7 dias,
 *                   e a estrategia de "ancora informada pelo cliente" quando a ANP
 *                   nao coletou o posto dele na semana. Ver FONTE-COMBUSTIVEL.md 3.
 */

/** Normaliza chave de praca/produto (sem acento, minusculo, sem espaco duplo). */
function norm (s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ')
}

/** "5,49" -> 5.49 ; "" -> null. A ANP usa virgula decimal. */
function parseNum (raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = Number.parseFloat(s.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** "dd/mm/aaaa" -> timestamp (para escolher a coleta mais recente). */
function parseDate (raw) {
  const m = String(raw || '').match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!m) return 0
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
}

/**
 * Le o CSV por revenda da ANP. Colunas padrao (Decreto 8.777/2016):
 * Regiao - Sigla;Estado - Sigla;Municipio;Revenda;CNPJ da Revenda;Nome da Rua;
 * Numero Rua;Complemento;Bairro;Cep;Produto;Data da Coleta;Valor de Venda;
 * Valor de Compra;Unidade de Medida;Bandeira
 * @param {string} text  conteudo do CSV (ja decodificado de latin1)
 * @returns {Array<object>} linhas normalizadas
 */
export function parseAnpCsv (text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return []

  const header = lines[0].split(';').map((h) => norm(h))
  const col = (name) => header.indexOf(norm(name))
  const idx = {
    regiao: col('Regiao - Sigla'),
    uf: col('Estado - Sigla'),
    municipio: col('Municipio'),
    revenda: col('Revenda'),
    cnpj: col('CNPJ da Revenda'),
    produto: col('Produto'),
    data: col('Data da Coleta'),
    valorVenda: col('Valor de Venda'),
    valorCompra: col('Valor de Compra'),
    unidade: col('Unidade de Medida'),
    bandeira: col('Bandeira')
  }

  const at = (cells, i) => (i >= 0 && i < cells.length ? cells[i].trim() : '')
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(';')
    rows.push({
      regiao: at(c, idx.regiao),
      uf: at(c, idx.uf),
      municipio: at(c, idx.municipio),
      revenda: at(c, idx.revenda),
      cnpj: at(c, idx.cnpj).replace(/\D/g, ''),
      produto: at(c, idx.produto),
      dataColeta: at(c, idx.data),
      dataTs: parseDate(at(c, idx.data)),
      valorVenda: parseNum(at(c, idx.valorVenda)),
      valorCompra: parseNum(at(c, idx.valorCompra)),
      unidade: at(c, idx.unidade),
      bandeira: at(c, idx.bandeira)
    })
  }
  return rows
}

/**
 * Filtra as linhas da ANP por municipio+produto e devolve Offer[] no formato
 * canonico. A ancora (`official`) e o posto do proprio cliente, casado por CNPJ.
 * Um posto pode ter varias coletas: fica a MAIS RECENTE.
 * @returns {import('./base.js').Offer[]}
 */
export function rowsToOffers (rows, { municipio, produto, ownCnpj, currency = 'BRL' }) {
  const wantMun = norm(municipio)
  const wantProd = norm(produto)
  const wantCnpj = String(ownCnpj || '').replace(/\D/g, '')

  const byCnpj = new Map()
  for (const r of rows) {
    if (wantMun && norm(r.municipio) !== wantMun) continue
    if (wantProd && !norm(r.produto).includes(wantProd)) continue
    if (r.valorVenda === null) continue
    const prev = byCnpj.get(r.cnpj)
    if (!prev || r.dataTs > prev.dataTs) byCnpj.set(r.cnpj, r)
  }

  return [...byCnpj.values()].map((r) => ({
    source: [r.bandeira, r.revenda].filter(Boolean).join(' - ') || r.cnpj,
    price: r.valorVenda,
    currency,
    official: Boolean(wantCnpj) && r.cnpj === wantCnpj,
    link: null,
    raw: r
  }))
}

/** Extrai municipio/uf/produto/ancora do alvo (colunas ou params JSONB). */
function fuelParams (target = {}) {
  const p = target.params || {}
  return {
    municipio: target.municipio ?? p.municipio ?? null,
    uf: target.uf ?? p.uf ?? null,
    produto: target.produto ?? p.produto ?? p.fuel_type ?? null,
    ownCnpj: target.own_cnpj ?? p.own_cnpj ?? p.cnpj ?? null
  }
}

export class FuelConnector extends Connector {
  get key () { return 'fuel_anp' }
  get vertical () { return 'fuel' }
  // NAO-MEDIDO: sem cota dura; so alimenta forecast (RFC 8.1).
  get metered () { return false }

  /**
   * Resolve a praca do subject. Nao ha chamada externa: o "handle" e a chave da
   * praca (municipio+UF). NAO persiste nada -- quem cacheia e o orquestrador.
   */
  async discover (subject, ctx) {
    const { municipio, uf } = fuelParams(subject)
    if (!municipio) throw new Error('FuelConnector.discover: subject sem municipio')
    return { handle: `${norm(municipio)}/${norm(uf)}`, name: `${municipio}${uf ? ` - ${uf}` : ''}` }
  }

  async fetchOffers (target, ctx) {
    const { municipio, produto, ownCnpj } = fuelParams(target)
    const rows = await this._loadRows(target, ctx)
    const currency = ctx?.currency ?? target.currency ?? 'BRL'
    return {
      offers: rowsToOffers(rows, { municipio, produto, ownCnpj, currency }),
      subjectName: municipio
    }
  }

  async probe (target, ctx) {
    const { municipio, produto, ownCnpj } = fuelParams(target)
    const rows = await this._loadRows(target, ctx)
    const offers = rowsToOffers(rows, { municipio, produto, ownCnpj })
    return { offers, meta: { municipio, produto, rowsRead: rows.length, source: 'ANP SLP por revenda' } }
  }

  /** Nao-medido: 0 para a guarda de cota. O custo real (1 download/praca) e por grupo. */
  costPerScan (target) { return 0 }

  /** Combustivel: a PRACA (municipio+produto) agrupa N alvos em 1 download. */
  costGroupKey (target) {
    const { municipio, uf, produto } = fuelParams(target)
    return `${norm(uf)}:${norm(municipio)}:${norm(produto)}`
  }

  /**
   * FASE 3: baixar o CSV da praca (dados-abertos ANP), decodificar latin1, cache
   * ~7 dias (arquivo semanal), e a estrategia de ancora informada pelo cliente
   * quando a ANP nao coletou o posto dele na semana. Injetar via ctx um
   * `ctx.dataset.loadAnpCsv(uf)` mantem o conector testavel e sem acoplar em HTTP.
   */
  async _loadRows (target, ctx) {
    if (ctx?.dataset?.loadAnpCsv) {
      const { uf } = fuelParams(target)
      const text = await ctx.dataset.loadAnpCsv(uf)
      return parseAnpCsv(text)
    }
    throw new Error(
      'FuelConnector._loadRows nao implementado (Fase 3): plugar download/cache do arquivo ANP ' +
      'por praca. Nucleo de parsing (parseAnpCsv/rowsToOffers) ja pronto e testado.'
    )
  }
}
