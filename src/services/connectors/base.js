/**
 * Contrato comum de conector de fonte de precos.
 *
 * Todo vertical (hotel, combustivel, ...) implementa esta interface; o scanner e
 * o motor de paridade falam SO com ela, nunca com a fonte concreta. O conector
 * nao le `config` global nem chama a guarda de orcamento direto: tudo o que ele
 * precisa chega via `ctx` (injecao de dependencia), para que o mesmo conector
 * sirva N tenants com credenciais e orcamentos diferentes.
 *
 * @typedef {Object} Offer  Oferta normalizada de um canal para um alvo/data.
 * @property {string}       source   - string crua da fonte (casada depois com channel.patterns)
 * @property {number|null}  price    - preco normalizado (diaria media no hotel)
 * @property {string}       currency - moeda (ex.: 'BRL')
 * @property {boolean}      official - true no canal direto (ancora de paridade)
 * @property {string|null} [link]    - link da oferta, quando houver
 * @property {object}      [raw]     - payload cru da fonte, para diagnostico
 *
 * @typedef {Object} ConnectorCtx  Contexto injetado pelo orquestrador (scanner).
 * @property {{apiKey?:string, endpoint?:string}} credentials - credenciais do conector no tenant
 * @property {{consume:Function, refund:Function, getUsage:Function}} budget - guarda de orcamento do tenant
 * @property {string} [currency] - moeda default do subject
 * @property {boolean} [allowReserve] - disparo manual pode usar a reserva de emergencia; o agendador nunca pode
 */

export class Connector {
  /** Chave estavel do conector (ex.: 'hotel_serpapi'). Usada no registry. */
  get key () { throw new Error('Connector.key nao implementado') }

  /** Vertical que este conector atende (ex.: 'hotel'). */
  get vertical () { throw new Error('Connector.vertical nao implementado') }

  /**
   * RFC 8.1: conector MEDIDO passa pela guarda atomica de orcamento (SerpAPI);
   * NAO-MEDIDO (ex.: ANP) nao tem cota dura e so alimenta o forecast.
   */
  get metered () { return true }

  /**
   * Descobre o handle estavel do subject (property_token no hotel). Custa 1x; o
   * handle e cacheado no subject pelo ORQUESTRADOR -- discover NAO escreve no banco.
   * @returns {Promise<{handle:string, name:string}>}
   */
  async discover (subject, ctx) { throw new Error('discover nao implementado') }

  /**
   * Ofertas de todos os canais para um alvo, JA NORMALIZADAS como Offer[].
   * @returns {Promise<{offers: Offer[], subjectName: string|null}>}
   */
  async fetchOffers (target, ctx) { throw new Error('fetchOffers nao implementado') }

  /**
   * Diagnostico: ofertas cruas de um alvo, SEM gravar nada.
   * @returns {Promise<{offers: Offer[], meta: object}>}
   */
  async probe (target, ctx) { throw new Error('probe nao implementado') }

  /**
   * Quantas requisicoes upstream este alvo custa por varredura (p/ forecast).
   * @returns {number}
   */
  costPerScan (target) { throw new Error('costPerScan nao implementado') }

  /**
   * Chave de agrupamento de custo: alvos com a MESMA chave sao servidos por 1
   * busca upstream (o orcamento conta 1 por grupo, nao por alvo). No hotel cada
   * alvo e uma busca propria; no combustivel a praca agrupa N alvos em 1 download.
   * @returns {string}
   */
  costGroupKey (target) { throw new Error('costGroupKey nao implementado') }
}
