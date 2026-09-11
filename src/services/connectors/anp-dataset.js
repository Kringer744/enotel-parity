/**
 * EXEMPLO de loader do dataset ANP para o FuelConnector (Fase 3).
 *
 * A ANP publica a Serie Historica de Precos por revenda em dados-abertos (CSV,
 * `;`, latin1/ISO-8859-1, decimal virgula), organizada por REGIAO e semestre. Este
 * modulo resolve a URL a partir da UF, baixa, decodifica latin1 e cacheia ~7 dias
 * (o arquivo e semanal). O parsing/filtragem fica no FuelConnector (parseAnpCsv).
 *
 * IMPORTANTE (mandato): este e o EXEMPLO de referencia. O vertical `fuel` so entra
 * no registry (connectors/index.js) quando este loader for VALIDADO contra um
 * arquivo real da praca do primeiro cliente (cobertura do municipio + drift de
 * colunas) -- ver Downloads/FONTE-COMBUSTIVEL.md. Nao consome cota SerpAPI: o
 * FuelConnector e NAO-MEDIDO.
 */

// UF -> regiao (IBGE); a ANP organiza a serie por regiao.
const UF_REGIAO = {
  AC: 'co', AP: 'no', AM: 'no', PA: 'no', RO: 'no', RR: 'no', TO: 'no',
  AL: 'ne', BA: 'ne', CE: 'ne', MA: 'ne', PB: 'ne', PE: 'ne', PI: 'ne', RN: 'ne', SE: 'ne',
  DF: 'co', GO: 'co', MT: 'co', MS: 'co',
  ES: 'se', MG: 'se', RJ: 'se', SP: 'se',
  PR: 'su', RS: 'su', SC: 'su'
}

// Host de dados-abertos da ANP. O nome exato do arquivo muda por semestre; F3
// valida/ajusta. Deixamos o padrao parametrizavel (base/ano/semestre).
const ANP_BASE = 'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/dsas/ca'

/** Semestre corrente (1|2) e ano, para compor o nome do arquivo. */
function currentPeriod (d = new Date()) {
  return { year: d.getUTCFullYear(), semester: d.getUTCMonth() < 6 ? 1 : 2 }
}

/**
 * Resolve a URL do arquivo ANP de combustiveis automotivos (ca) para uma UF.
 * Ex.: PE -> regiao 'ne' -> .../ca-2026-02.csv (2o semestre de 2026).
 * O path exato e um EXEMPLO -- validar em F3.
 */
export function anpUrlFor (uf, { base = ANP_BASE, year, semester } = {}) {
  const regiao = UF_REGIAO[String(uf || '').toUpperCase()]
  if (!regiao) throw new Error(`UF sem regiao mapeada: "${uf}"`)
  const p = (year && semester) ? { year, semester } : currentPeriod()
  return `${base}/ca-${p.year}-${String(p.semester).padStart(2, '0')}.csv`
}

// Cache em memoria por URL: o arquivo ANP e semanal, entao ~7 dias basta.
const cache = new Map()
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Baixa e decodifica (latin1) o CSV da praca. Cache ~7 dias por URL.
 * @param {string} uf  sigla do estado (ex.: 'PE')
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  injetavel para teste (sem rede real)
 * @param {number} [opts.ttlMs]  janela de cache (default 7 dias)
 * @param {boolean} [opts.force]  ignora o cache
 * @param {() => number} [opts.now]  relogio injetavel para teste
 * @returns {Promise<string>} conteudo do CSV ja decodificado
 */
export async function loadAnpCsv (uf, { fetchImpl = fetch, ttlMs = WEEK_MS, force = false, now = Date.now, ...urlOpts } = {}) {
  const url = anpUrlFor(uf, urlOpts)
  const hit = cache.get(url)
  if (!force && hit && (now() - hit.at) < ttlMs) return hit.text

  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`ANP ${uf}: HTTP ${res.status} em ${url}`)
  const buf = await res.arrayBuffer()
  // A ANP publica em latin1/ISO-8859-1 -- decodificar como utf-8 corromperia acentos.
  const text = new TextDecoder('latin1').decode(buf)
  cache.set(url, { at: now(), text })
  return text
}

/** Limpa o cache (util em teste). */
export function clearAnpCache () { cache.clear() }
