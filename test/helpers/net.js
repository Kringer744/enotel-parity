// Stub de global.fetch para os testes que exercitam a camada SerpAPI/budget.
// Registra cada requisicao para o teste inspecionar (ex.: provar que fetchOffers
// manda `q` junto do property_token).

const realFetch = globalThis.fetch

export const calls = []

/**
 * Instala um fetch falso.
 * @param {(url:URL, requestNo:number) => {status?:number, body:any}} route
 *   recebe a URL de cada chamada e devolve o corpo JSON a responder.
 */
export function mockFetch (route) {
  calls.length = 0
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    calls.push(url)
    const { status = 200, body = {} } = route(url, calls.length) || {}
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    }
  }
}

/** Instala um fetch que sempre estoura (simula falha de rede). */
export function mockFetchNetworkError (message = 'ECONNREFUSED') {
  calls.length = 0
  globalThis.fetch = async (input) => {
    calls.push(new URL(String(input)))
    throw new Error(message)
  }
}

export function restoreFetch () {
  globalThis.fetch = realFetch
  calls.length = 0
}

/** True se a URL for a consulta de saldo gratuita da SerpAPI (/account). */
export const isAccountUrl = (url) => url.pathname.endsWith('/account')

/** Resposta padrao de /account com saldo folgado, para consume() liberar. */
export const accountBody = (over = {}) => ({
  plan_name: 'Free',
  searches_per_month: 250,
  this_month_usage: 96,
  plan_searches_left: 154,
  total_searches_left: 154,
  this_hour_searches: 0,
  account_email: 'ti@fluxodigitaltech.com.br',
  ...over
})
