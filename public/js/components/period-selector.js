import { api } from '../api.js'
import { toast, busy, refreshIcons } from '../ui.js'
import { TODAY } from '../core/state.js'
import { waitForScan } from './scan.js'

/* Seletor de período de estadia (F2 — design da Aurora, CA da Bússola QA-SEL-*).
   Range check-in→check-out num calendário de 2 meses, noites automáticas,
   atalhos (fim de semana / Réveillon / próximos 7-30-60 dias), piso = hoje.
   Duas ações sem jargão: "Ver os preços agora" (efêmero, uma atualização) e
   "Passar a acompanhar" (recorrente). Encapsulado: consulta só dentro de `host`. */

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const pad = (n) => String(n).padStart(2, '0')
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`
// Meia-noite-UTC do meio-dia: evita o off-by-one de fuso (regra do projeto).
const parse = (s) => new Date(`${s}T12:00:00Z`)
const nightsBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000)
const addDaysISO = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const fmtLong = (s) => { const d = parse(s); return `${DOW[d.getUTCDay()]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}` }

/** Atalhos ancorados em "hoje" (Recife UTC-3 sem horário de verão). */
function buildShortcuts () {
  const t = parse(TODAY)
  const toFri = (5 - t.getUTCDay() + 7) % 7          // próxima sexta (0 se hoje já é sexta)
  const thisFri = addDaysISO(TODAY, toFri)
  const thisSun = addDaysISO(thisFri, 2)
  const nextFri = addDaysISO(thisFri, 7)
  const nextSun = addDaysISO(nextFri, 2)
  const y = t.getUTCFullYear()
  const revYear = TODAY <= `${y}-12-30` ? y : y + 1  // Réveillon deste ano, ou do próximo se já passou
  return [
    {
      g: 'Datas certas',
      items: [
        { id: 'wknd-this', icon: 'sun', label: 'Este fim de semana', ci: thisFri, co: thisSun },
        { id: 'wknd-next', icon: 'sun', label: 'Próximo fim de semana', ci: nextFri, co: nextSun },
        { id: 'reveillon', icon: 'star', label: 'Réveillon', ci: `${revYear}-12-30`, co: `${revYear + 1}-01-02` }
      ]
    },
    {
      g: 'Sempre à frente',
      items: [
        { id: 'r7', icon: 'clock', label: 'Próximos 7 dias', roll: 7 },
        { id: 'r30', icon: 'repeat', label: 'Próximos 30 dias', roll: 30 },
        { id: 'r60', icon: 'repeat', label: 'Próximos 60 dias', roll: 60 }
      ]
    }
  ]
}

/**
 * Monta o seletor dentro de `host`.
 * opts: { onClose?, onCreated?, onScanStart?, onScanned? } — a página decide como
 * fechar/recarregar. Sem onClose, o "X" não aparece (uso inline).
 */
export function renderPeriodSelector (host, opts = {}) {
  const shortcuts = buildShortcuts()
  const today = parse(TODAY)
  const st = { mode: 'fixed', ci: null, co: null, roll: null, short: null, adults: 2, y: today.getUTCFullYear(), m: today.getUTCMonth() }

  host.innerHTML = `
    <div class="ps-pop">
      <div class="ps-head">
        <div class="ps-title">Que período você quer ver?</div>
        <div class="row" style="gap:12px">
          <span class="ps-note"><i data-lucide="calendar" class="icon-sm"></i>mínimo hoje</span>
          ${opts.onClose ? '<button type="button" class="ps-x" id="ps-close" aria-label="Fechar"><i data-lucide="x" class="icon-sm"></i></button>' : ''}
        </div>
      </div>
      <div class="ps-body">
        <div class="ps-rail" id="ps-rail" role="group" aria-label="Atalhos de período"></div>
        <div>
          <div class="ps-cal" id="ps-cal"></div>
          <div class="ps-summary">
            <div class="ps-sum-dates" id="ps-sum"></div>
            <span class="ps-nights" id="ps-nights" aria-live="polite"></span>
            <label class="ps-guests">Hóspedes
              <select id="ps-guests">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${n === 2 ? ' selected' : ''}>${n}</option>`).join('')}</select>
            </label>
          </div>
        </div>
      </div>
      <div class="ps-actions">
        <div class="ps-act-help">Escolha o que fazer com esse período:</div>
        <div class="ps-act-row">
          <button type="button" class="ps-act" id="ps-see">
            <div class="t"><i data-lucide="eye" class="icon-sm"></i>Ver os preços agora</div>
            <div class="d">Mostra os preços deste período agora. Leva alguns segundos.</div>
          </button>
          <button type="button" class="ps-act primary" id="ps-watch">
            <div class="t"><i data-lucide="bell" class="icon-sm"></i><span id="ps-watch-label">Passar a acompanhar</span></div>
            <div class="d" id="ps-watch-desc">Acompanho todo dia até a data e te aviso se um canal ficar abaixo do seu preço.</div>
          </button>
        </div>
      </div>
    </div>`

  const $ = (id) => host.querySelector('#' + id)

  function renderRail () {
    $('ps-rail').innerHTML = shortcuts.map((grp) =>
      `<div class="ps-rail-lbl">${grp.g}</div>` +
      grp.items.map((it) =>
        `<button type="button" class="ps-short${st.short === it.id ? ' on' : ''}" data-s="${it.id}" aria-pressed="${st.short === it.id}">
           <i data-lucide="${it.icon}" class="icon-sm"></i><span>${it.label}</span>
         </button>`).join('')).join('')
    $('ps-rail').querySelectorAll('[data-s]').forEach((b) =>
      b.addEventListener('click', () => pickShortcut(b.dataset.s)))
    refreshIcons($('ps-rail'))
  }

  function pickShortcut (id) {
    st.short = id
    const it = shortcuts.flatMap((g) => g.items).find((x) => x.id === id)
    if (it.roll) { st.mode = 'rolling'; st.roll = it.roll; st.ci = null; st.co = null } else {
      st.mode = 'fixed'; st.roll = null; st.ci = it.ci; st.co = it.co
      const d = parse(it.ci); st.y = d.getUTCFullYear(); st.m = d.getUTCMonth()
    }
    renderRail(); renderCal(); renderSummary()
  }

  function monthGrid (y, m) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay()
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    let cells = ''
    for (let i = 0; i < first; i++) cells += '<div class="ps-day blank"></div>'
    for (let d = 1; d <= dim; d++) {
      const s = isoOf(y, m, d)
      let cls = 'ps-day'; let sel = false
      const disabled = s < TODAY                       // `<` e não `<=`: hoje é válido (reserva de última hora)
      if (disabled) cls += ' disabled'
      if (s === TODAY) cls += ' today'
      if (st.mode === 'fixed' && st.ci && st.co) {
        if (s >= st.ci && s <= st.co) { cls += ' rng'; sel = true }
        if (s === st.ci) cls += ' start'
        if (s === st.co) cls += ' end'
      } else if (st.mode === 'fixed' && st.ci && !st.co && s === st.ci) { cls += ' start end'; sel = true }
      const anchor = st.ci ? (s === st.ci) : (s === TODAY)
      const a11y = disabled
        ? ' aria-disabled="true"'
        : ` role="gridcell" tabindex="${anchor ? 0 : -1}" aria-selected="${sel}"${s === TODAY ? ' aria-current="date"' : ''}`
      cells += `<div class="${cls}" data-d="${s}"${a11y}>${d}</div>`
    }
    return `<div class="ps-month">
      <div class="ps-month-name">${MONTHS[m]} ${y}</div>
      <div class="ps-dow">${DOW.map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="ps-days" role="grid" aria-label="${MONTHS[m]} ${y}">${cells}</div>
    </div>`
  }

  function renderCal () {
    const el = $('ps-cal')
    if (st.mode === 'rolling') {
      el.innerHTML = `<div class="ps-roll-note">
        <div class="ps-roll-ic"><i data-lucide="repeat" class="icon-lg"></i></div>
        <div class="ps-roll-title">Sempre ${st.roll} dias à frente</div>
        <p>A data anda com o tempo: todo dia a gente olha o período que começa daqui a ${st.roll} dias. Bom pra sentir o comportamento geral do canal.</p>
      </div>`
      refreshIcons(el)
      return
    }
    const ny = st.m === 11 ? st.y + 1 : st.y
    const nm = (st.m + 1) % 12
    const prevDisabled = (st.y < today.getUTCFullYear()) ||
      (st.y === today.getUTCFullYear() && st.m <= today.getUTCMonth())
    el.innerHTML = `<div class="ps-cal-nav">
        <button type="button" id="ps-prev" ${prevDisabled ? 'disabled' : ''} aria-label="Mês anterior"><i data-lucide="chevron-left" class="icon-sm"></i></button>
        <div style="flex:1"></div>
        <button type="button" id="ps-next" aria-label="Próximo mês"><i data-lucide="chevron-right" class="icon-sm"></i></button>
      </div>
      <div class="ps-months">${monthGrid(st.y, st.m)}${monthGrid(ny, nm)}</div>`
    const prev = $('ps-prev'); const next = $('ps-next')
    if (prev && !prevDisabled) prev.addEventListener('click', () => { st.m--; if (st.m < 0) { st.m = 11; st.y-- } renderCal() })
    if (next) next.addEventListener('click', () => { st.m++; if (st.m > 11) { st.m = 0; st.y++ } renderCal() })
    el.querySelectorAll('[data-d]').forEach((c) => {
      if (c.classList.contains('disabled') || c.classList.contains('blank')) return
      c.addEventListener('click', () => pickDay(c.dataset.d))
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickDay(c.dataset.d) } })
    })
    refreshIcons(el)
  }

  function pickDay (s) {
    st.mode = 'fixed'; st.roll = null; st.short = null
    if (!st.ci || (st.ci && st.co)) { st.ci = s; st.co = null } else if (s > st.ci) { st.co = s } else { st.ci = s; st.co = null }
    renderRail(); renderCal(); renderSummary()
  }

  function renderSummary () {
    const sum = $('ps-sum'); const nb = $('ps-nights')
    const wl = $('ps-watch-label'); const wd = $('ps-watch-desc')
    const see = $('ps-see'); const watch = $('ps-watch')
    if (st.mode === 'rolling') {
      sum.innerHTML = `<b>Sempre ${st.roll} dias à frente</b> · janela de 2 noites`
      nb.innerHTML = '<i data-lucide="repeat" class="icon-sm"></i>janela móvel'
      wl.textContent = 'Acompanhar sempre essa janela'
      wd.textContent = 'Todo dia eu olho o período à frente e te aviso se um canal ficar abaixo do seu preço.'
      see.disabled = false; watch.disabled = false
    } else if (st.ci && st.co) {
      const n = nightsBetween(st.ci, st.co)
      sum.innerHTML = `Entrada <b>${fmtLong(st.ci)}</b> · Saída <b>${fmtLong(st.co)}</b>`
      nb.innerHTML = `<i data-lucide="moon" class="icon-sm"></i>${n} ${n === 1 ? 'noite' : 'noites'}`
      wl.textContent = 'Passar a acompanhar'
      wd.textContent = 'Acompanho todo dia até a data e te aviso se um canal ficar abaixo do seu preço.'
      see.disabled = false; watch.disabled = false
    } else {
      sum.innerHTML = `Entrada <b>${st.ci ? fmtLong(st.ci) : '—'}</b> · escolha a saída`
      nb.innerHTML = '<i data-lucide="moon" class="icon-sm"></i>— noites'
      wl.textContent = 'Passar a acompanhar'
      wd.textContent = 'Escolha a data de saída para continuar.'
      see.disabled = true; watch.disabled = true
    }
    refreshIcons(nb)
  }

  const validPeriod = () => (st.mode === 'rolling' ? !!st.roll : !!(st.ci && st.co))
  const spec = (ephemeral) => (st.mode === 'rolling'
    ? { mode: 'rolling', horizon_days: st.roll, los: 2, adults: st.adults, ephemeral }
    : { mode: 'fixed', check_in: st.ci, check_out: st.co, adults: st.adults, ephemeral })

  async function createTarget (ephemeral) {
    const props = await api.properties()
    const prop = props.find((p) => p.active) || props[0]
    if (!prop) throw new Error('Nenhuma propriedade cadastrada')
    return api.createTarget({ property_id: prop.id, ...spec(ephemeral) })
  }

  $('ps-guests').addEventListener('change', (e) => { st.adults = Number(e.target.value) })
  if (opts.onClose) $('ps-close').addEventListener('click', () => opts.onClose())

  $('ps-watch').addEventListener('click', async (ev) => {
    if (!validPeriod()) return
    busy(ev.currentTarget, true, 'Salvando…')
    try {
      await createTarget(false)
      toast('Período no acompanhamento. Entra na próxima atualização.', 'ok')
      busy(ev.currentTarget, false)
      if (opts.onCreated) opts.onCreated()
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })

  $('ps-see').addEventListener('click', async (ev) => {
    if (!validPeriod()) return
    busy(ev.currentTarget, true, 'Buscando…')
    try {
      await createTarget(true)
      await api.runScan()
      if (opts.onScanStart) opts.onScanStart()
      const scan = await waitForScan()
      if (scan && (scan.status === 'ok' || scan.status === 'partial')) {
        toast(`${scan.rates_captured ?? 0} preços atualizados`, 'ok')
      } else if (scan) {
        toast(`Atualização ${scan.status}: ${scan.message || 'sem detalhes'}`, 'error')
      }
      busy(ev.currentTarget, false)
      if (opts.onScanned) opts.onScanned(scan)
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })

  renderRail(); renderCal(); renderSummary()
  refreshIcons(host)
}
