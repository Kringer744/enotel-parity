import { api } from '../api.js'
import { loading, emptyState, escapeHtml, fmtDate, pct, refreshIcons } from '../ui.js'
import { money2 } from '../charts.js'
import { renderPeriodSelector } from '../components/period-selector.js'

/* ═══ Tarifas atuais ══════════════════════════════════════════════════════ */

export async function pageRates (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Tarifas atuais</h1>
        <p class="page-sub">Fotografia da última atualização, por data de entrada</p>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div>
          <div class="card-title">Ver um período específico</div>
          <div class="card-note">
            Escolha a estadia no calendário. "Ver agora" mostra os preços na hora;
            "Passar a acompanhar" monitora todo dia até a data chegar.
          </div>
        </div>
      </div>
      <div class="ps-inline" id="rates-selector"></div>
    </div>

    <div id="rates">${loading('Carregando os preços da última atualização...', 320)}</div>`

  renderPeriodSelector(document.getElementById('rates-selector'), {
    onCreated: () => pageRates(main),
    onScanStart: () => { document.getElementById('rates').innerHTML = loading('Buscando os preços do período escolhido...', 320) },
    onScanned: () => pageRates(main)
  })

  const groups = await api.currentRates()
  const host = document.getElementById('rates')

  if (groups.length === 0) {
    host.innerHTML = `<div class="card">${emptyState('info', 'Nenhum preço coletado ainda. Faça uma atualização no Painel.')}</div>`
    refreshIcons(main)
    return
  }

  host.innerHTML = groups.map((g) => {
    const sorted = [...g.offers].sort((a, b) => a.price - b.price)
    const cheapest = sorted[0]
    return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(g.targetLabel || `Entrada ${fmtDate(g.checkIn)}`)}</div>
          <div class="card-note">
            ${fmtDate(g.checkIn)} → ${fmtDate(g.checkOut)} · ${g.los} noites ·
            seu preço oficial ${g.directPrice ? money2(g.directPrice) : '<span class="badge warning">ausente</span>'}
          </div>
        </div>
        ${cheapest ? `<div class="badge ${cheapest.kind === 'direct' ? 'good' : 'critical'}">
          ${cheapest.kind === 'direct'
            ? '<i data-lucide="check" class="icon-sm"></i>Seu preço é o mais barato'
            : `<i data-lucide="ban" class="icon-sm"></i>${escapeHtml(cheapest.name)} está mais barato`}
        </div>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Canal</th><th class="num">Diária</th><th class="num">vs. seu preço</th><th>Situação</th>
          </tr></thead>
          <tbody>
            ${sorted.map((o) => `
              <tr>
                <td>
                  <span class="channel-key">
                    <span class="channel-swatch" style="background:${o.color}"></span>
                    ${escapeHtml(o.name)}${o.kind === 'direct' ? ' <span class="badge neutral">oficial</span>' : ''}
                  </span>
                </td>
                <td class="num strong">${money2(o.price)}</td>
                <td class="num mono">${o.deltaPct === null ? '—' : `${o.deltaPct > 0 ? '+' : ''}${pct(o.deltaPct)}`}</td>
                <td>${
                  o.kind === 'direct' ? '<span class="badge info">Referência</span>'
                  : o.deltaPct === null ? '<span class="badge neutral">—</span>'
                  : o.deltaPct < -1 ? '<span class="badge critical"><i data-lucide="ban" class="icon-sm"></i>Abaixo do seu</span>'
                  : o.deltaPct > 1 ? '<span class="badge neutral"><i data-lucide="arrow-up" class="icon-sm"></i>Acima do seu</span>'
                  : '<span class="badge good"><i data-lucide="check" class="icon-sm"></i>Em paridade</span>'
                }</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`
  }).join('')
  refreshIcons(main)
}
