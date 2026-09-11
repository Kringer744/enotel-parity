import { config } from '../config.js'
import * as budget from '../lib/budget.js'
import {
  SerpApiError,
  datesForHorizon,
  discoverToken,
  fetchOffersFor,
  runProbe
} from './connectors/hotel-serpapi.js'

/**
 * Adaptador de compatibilidade do conector de hotel (SerpAPI).
 *
 * A logica real vive em `connectors/hotel-serpapi.js` (extraida sem alterar
 * comportamento). Este modulo preserva a API antiga -- `findPropertyToken`,
 * `fetchOffers`, `probe`, `datesForHorizon`, `SerpApiError` -- para que
 * `scanner.js` e `routes/index.js` sigam funcionando SEM edicao. O Cortex religa
 * o scanner ao registry (`connectors/index.js`) na passada de multi-tenant.
 *
 * Aqui montamos o `ctx` global default: credenciais do `config` + a guarda de
 * orcamento global atual. E o unico ponto que ainda le `config`/`budget`; quando
 * o orcamento por-tenant entrar (RFC 11.4), so a FONTE do ctx muda -- o conector
 * nao muda.
 */
function defaultCtx () {
  return {
    credentials: { apiKey: config.serpapi.key, endpoint: config.serpapi.endpoint },
    budget,
    currency: 'BRL'
  }
}

export { SerpApiError, datesForHorizon }

export function findPropertyToken (serpQuery, dates, opts = {}) {
  return discoverToken(serpQuery, dates, defaultCtx(), opts)
}

export function fetchOffers (propertyToken, q, dates, opts = {}) {
  return fetchOffersFor(propertyToken, q, dates, defaultCtx(), opts)
}

export function probe (target, opts = { allowReserve: true }) {
  return runProbe(target, defaultCtx(), opts)
}
