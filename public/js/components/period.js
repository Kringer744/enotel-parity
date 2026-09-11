import { state } from '../core/state.js'

/** Seletor de janela (7/30/90 dias) compartilhado por Painel, Violacoes e Relatorio. */
export function periodPicker () {
  return `
    <div class="segmented" id="period">
      ${[7, 30, 90].map((d) => `
        <button data-days="${d}" class="${state.days === d ? 'active' : ''}">${d} dias</button>
      `).join('')}
    </div>`
}

export function wirePeriod (rerender) {
  document.getElementById('period')?.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.days = Number(b.dataset.days)
      rerender()
    }))
}
