import { api } from '../api.js'
import { loading, emptyState, escapeHtml, fmtDate, pct, toast, busy, refreshIcons } from '../ui.js'
import { money2 } from '../charts.js'
import { TODAY } from '../core/state.js'
import { waitForScan } from '../components/scan.js'

/* ═══ Tarifas atuais ══════════════════════════════════════════════════════ */

/**
 * Liga o seletor de período fixo do topo de "Tarifas atuais".
 * "Só monitorar" cadastra e espera a próxima varredura; "Puxar agora" cadastra
 * e dispara a varredura na hora, que é o caminho que gasta requisição.
 */
function wireFixedPeriod (main) {
  const checkIn = document.getElementById('r-checkin')
  const checkOut = document.getElementById('r-checkout')
  const hint = document.getElementById('r-hint')

  api.budget().then((b) => {
    hint.textContent =
      `Ver agora usa ${b.perScan + 1} consultas de preço (todos os períodos ativos mais este). ` +
      `Restam ${b.remaining} de ${b.limit} este mês.`
  }).catch(() => { hint.textContent = '' })

  // O check-out nunca pode ser anterior ou igual ao check-in.
  checkIn.addEventListener('change', () => {
    const min = new Date(`${checkIn.value}T12:00:00Z`)
    min.setUTCDate(min.getUTCDate() + 1)
    checkOut.min = min.toISOString().slice(0, 10)
    if (!checkOut.value || checkOut.value <= checkIn.value) checkOut.value = checkOut.min
  })

  const create = async () => {
    if (!checkIn.value || !checkOut.value) throw new Error('Escolha as datas de entrada e saída')
    if (checkOut.value <= checkIn.value) throw new Error('A saída precisa ser depois da entrada')
    const props = await api.properties()
    const prop = props.find((p) => p.active) || props[0]
    if (!prop) throw new Error('Nenhuma propriedade cadastrada')
    return api.createTarget({
      property_id: prop.id,
      mode: 'fixed',
      check_in: checkIn.value,
      check_out: checkOut.value,
      adults: Number(document.getElementById('r-adults').value)
    })
  }

  document.getElementById('r-add').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Salvando...')
    try {
      await create()
      toast('Período adicionado. Entra na próxima atualização.', 'ok')
    } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.getElementById('r-pull').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Atualizando...')
    try {
      await create()
      await api.runScan()
      document.getElementById('rates').innerHTML =
        loading('Buscando os preços do período escolhido...', 320)
      const scan = await waitForScan()
      if (scan && (scan.status === 'ok' || scan.status === 'partial')) {
        toast(`${scan.rates_captured} preços coletados`, 'ok')
      } else if (scan) {
        toast(`A atualização não completou: ${scan.message || 'tente de novo em instantes'}`, 'error')
      }
      return pageRates(main)
    } catch (err) {
      toast(err.message, 'error')
      busy(ev.currentTarget, false)
    }
  })
}

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
            Escolha as datas da estadia. O período passa a ser acompanhado
            diariamente até a data chegar, e depois sai sozinho.
          </div>
        </div>
      </div>
      <div class="date-picker">
        <div class="date-field">
          <label><i data-lucide="calendar" class="icon-sm"></i>Entrada</label>
          <input class="input" type="date" id="r-checkin" min="${TODAY}">
        </div>
        <div class="date-field">
          <label><i data-lucide="calendar-check" class="icon-sm"></i>Saída</label>
          <input class="input" type="date" id="r-checkout" min="${TODAY}">
        </div>
        <div class="date-field" style="max-width:130px">
          <label><i data-lucide="users" class="icon-sm"></i>Hóspedes</label>
          <select class="select" id="r-adults">
            ${[1, 2, 3, 4, 5, 6].map((n) =>
              `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </div>
        <button class="btn secondary" id="r-add">Só acompanhar</button>
        <button class="btn" id="r-pull">Ver agora</button>
      </div>
      <p class="muted small" id="r-hint" style="margin-top:10px"></p>
    </div>

    <div id="rates">${loading('Carregando os preços da última atualização...', 320)}</div>`

  wireFixedPeriod(main)

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
