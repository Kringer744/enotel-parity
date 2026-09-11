/* Estado global compartilhado da SPA e navegacao por evento.
   Um unico objeto `state` e mutado no lugar por todas as pages/componentes;
   como e o mesmo binding importado, as mutacoes valem entre os modulos. */

export const state = {
  user: null,
  page: 'dashboard',
  days: 30,
  openCount: 0,
  trendTarget: null
}

// Piso dos seletores de data. Check-in no proprio dia e valido: e reserva
// de ultima hora, e o Google Hotels devolve tarifa para hoje.
export const TODAY = (() => {
  const d = new Date()
  return d.toISOString().slice(0, 10)
})()

/**
 * Navega para uma pagina disparando um evento -- o roteador escuta e troca a
 * tela. Desacopla as pages e componentes do roteador (sem ciclo de import).
 */
export function navigate (page) {
  window.dispatchEvent(new CustomEvent('navigate', { detail: page }))
}

/** Pede ao roteador que redesenhe a navegacao (ex.: badge de contagem mudou). */
export function refreshNav () {
  window.dispatchEvent(new CustomEvent('nav:refresh'))
}
