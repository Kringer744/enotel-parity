import { escapeHtml, refreshIcons, toast } from '../ui.js'
import { api } from '../api.js'
import { waitForScan } from './scan.js'

/* Onboarding guiado (3 passos + resumo/coleta) — design da Aurora.
   Fluxo de primeiro acesso, sem jargão: acha o hotel, escolhe canais, escolhe
   o que acompanhar, confere e faz a primeira atualização. */

const OB_CHANNELS = [
  { name: 'Booking.com', color: '#2a78d6', on: true },
  { name: 'Expedia', color: '#1baf7a', on: true },
  { name: 'Hotéis.com', color: '#eb6834', on: true },
  { name: 'Trip.com', color: '#e34948', on: true },
  { name: 'MaxMilhas', color: '#e87ba4', on: true },
  { name: 'Azul Viagens', color: '#eda100', on: false }
]
const OB_WATCH = [
  { id: 'r30', title: 'Próximos 30 dias', desc: 'O período mais comum. Já deixei marcado.', icon: 'calendar' },
  { id: 'r7', title: 'Próximos 7 dias', desc: 'Curto prazo, reservas de última hora.', icon: 'clock' },
  { id: 'fixed', title: 'Uma data específica', desc: 'Um feriado, o Réveillon, um evento.', icon: 'star' }
]

export function renderOnboarding (host, opts = {}) {
  const st = { step: 1, watch: 'r30', channels: OB_CHANNELS.map((c) => ({ ...c })) }
  const $ = (id) => host.querySelector('#' + id)

  const bars = (n) => `
    <div class="ob-head">
      <span class="ob-step">Passo ${n} de 3</span>
      <span class="ob-crumbs">Seu negócio · Canais · O que acompanhar</span>
    </div>
    <div class="ob-bars">${[1, 2, 3].map((i) => `<span class="${i <= n ? 'on' : ''}"></span>`).join('')}</div>`

  function step1 () {
    host.innerHTML = `<div class="ob-card">
      ${bars(1)}
      <h2 class="ob-h2">Qual é o seu hotel?</h2>
      <p class="ob-sub">Escreva o nome e a cidade. A gente encontra pra você.</p>
      <div class="ob-stack" style="gap:14px">
        <div class="ob-field"><label>Nome do hotel</label><input class="input" id="ob-name" value="Enotel Resort"></div>
        <div class="ob-field"><label>Cidade</label><input class="input" id="ob-city" value="Ipojuca, PE"></div>
      </div>
      <div style="margin-top:22px">
        <div class="muted small strong" style="margin-bottom:10px;color:var(--ink-2)">É algum destes?</div>
        <div class="ob-stack">
          <div class="ob-row ob-ref">
            <div class="ob-mark"><i data-lucide="building-2" class="icon-sm"></i></div>
            <div style="flex:1"><div class="strong">Enotel Convention &amp; Spa</div><div class="muted small">Porto de Galinhas · Ipojuca, PE</div></div>
            <span class="badge info"><i data-lucide="check" class="icon-sm"></i>Selecionado</span>
          </div>
          <div class="ob-row">
            <div class="ob-mark"><i data-lucide="building-2" class="icon-sm"></i></div>
            <div style="flex:1"><div class="strong">Enotel Acqua Club</div><div class="muted small">Porto de Galinhas · Ipojuca, PE</div></div>
          </div>
        </div>
      </div>
      <div class="ob-foot">
        <button type="button" class="btn ghost" id="ob-back">Cancelar</button>
        <button type="button" class="btn" id="ob-next">Continuar <i data-lucide="arrow-right" class="icon-sm"></i></button>
      </div></div>`
    $('ob-back').addEventListener('click', () => opts.onClose && opts.onClose())
    $('ob-next').addEventListener('click', () => { st.step = 2; render() })
    refreshIcons(host)
  }

  function step2 () {
    host.innerHTML = `<div class="ob-card">
      ${bars(2)}
      <h2 class="ob-h2">Onde você quer comparar?</h2>
      <p class="ob-sub">Deixe ligados os canais que vendem o seu hotel. A gente compara o preço deles com o seu preço oficial.</p>
      <div class="ob-row ob-ref" style="margin-bottom:14px">
        <div class="ob-mark" style="background:var(--surface);color:var(--accent)"><i data-lucide="home" class="icon-sm"></i></div>
        <div style="flex:1"><div class="strong">Seu site oficial</div><div class="muted small">A comparação parte daqui</div></div>
        <span class="badge info"><i data-lucide="lock" class="icon-sm"></i>Sua referência</span>
      </div>
      <div class="ob-stack">
        ${st.channels.map((c, i) => `
          <div class="ob-row">
            <span class="ob-swatch" style="background:${c.color}"></span>
            <div style="flex:1" class="strong">${escapeHtml(c.name)}</div>
            <label class="switch"><input type="checkbox" data-ch="${i}" ${c.on ? 'checked' : ''}><span class="track"></span></label>
          </div>`).join('')}
      </div>
      <div class="ob-note"><i data-lucide="info" class="icon-sm" style="color:var(--ink-3)"></i>
        <div>Um canal é um site que vende o seu hotel. Se aparecer vendendo abaixo do seu preço, a gente te avisa.</div></div>
      <div class="ob-foot">
        <button type="button" class="btn ghost" id="ob-back"><i data-lucide="arrow-left" class="icon-sm"></i>Voltar</button>
        <button type="button" class="btn" id="ob-next">Continuar <i data-lucide="arrow-right" class="icon-sm"></i></button>
      </div></div>`
    host.querySelectorAll('[data-ch]').forEach((cb) =>
      cb.addEventListener('change', () => { st.channels[Number(cb.dataset.ch)].on = cb.checked }))
    $('ob-back').addEventListener('click', () => { st.step = 1; render() })
    $('ob-next').addEventListener('click', () => { st.step = 3; render() })
    refreshIcons(host)
  }

  function step3 () {
    host.innerHTML = `<div class="ob-card">
      ${bars(3)}
      <h2 class="ob-h2">O que você quer acompanhar?</h2>
      <p class="ob-sub">Escolha as datas que mais importam. Dá pra mudar depois.</p>
      <div class="ob-stack" style="gap:10px">
        ${OB_WATCH.map((w) => `
          <button type="button" class="ob-opt${st.watch === w.id ? ' sel' : ''}" data-w="${w.id}" aria-pressed="${st.watch === w.id}">
            <span class="ob-rad"></span>
            <div style="flex:1"><div class="strong">${w.title}</div><div class="muted small" style="margin-top:2px">${w.desc}</div></div>
            <i data-lucide="${w.icon}" class="icon-sm"></i>
          </button>`).join('')}
      </div>
      <div class="ob-note"><i data-lucide="info" class="icon-sm" style="color:var(--ink-3)"></i>
        <div>Dá pra acompanhar até <strong>8 períodos ao mesmo tempo</strong>. Você marcou 1.</div></div>
      <div class="ob-foot">
        <button type="button" class="btn ghost" id="ob-back"><i data-lucide="arrow-left" class="icon-sm"></i>Voltar</button>
        <button type="button" class="btn" id="ob-next">Continuar <i data-lucide="arrow-right" class="icon-sm"></i></button>
      </div></div>`
    host.querySelectorAll('[data-w]').forEach((b) =>
      b.addEventListener('click', () => { st.watch = b.dataset.w; step3() }))
    $('ob-back').addEventListener('click', () => { st.step = 2; render() })
    $('ob-next').addEventListener('click', () => { st.step = 4; render() })
    refreshIcons(host)
  }

  function summary () {
    const on = st.channels.filter((c) => c.on)
    const chNames = on.slice(0, 4).map((c) => c.name.replace('.com', '')).join(', ')
    const extra = on.length > 4 ? ` +${on.length - 4}` : ''
    const watchLabel = (OB_WATCH.find((w) => w.id === st.watch) || OB_WATCH[0]).title
    host.innerHTML = `<div class="ob-card">
      <h2 class="ob-h2">Tudo certo?</h2>
      <p class="ob-sub">Confira antes de buscar os preços.</p>
      <div class="ob-stack">
        <div class="ob-row" style="border-color:transparent;padding-left:0">
          <div class="ob-mark"><i data-lucide="building-2" class="icon-sm"></i></div>
          <div><div class="muted small">Hotel</div><div class="strong">Enotel Convention &amp; Spa · Ipojuca, PE</div></div>
        </div>
        <div class="ob-row" style="border-color:transparent;padding-left:0">
          <div class="ob-mark"><i data-lucide="tags" class="icon-sm"></i></div>
          <div><div class="muted small">Canais</div><div class="strong">${escapeHtml(chNames)}${extra} · e seu site oficial</div></div>
        </div>
        <div class="ob-row" style="border-color:transparent;padding-left:0">
          <div class="ob-mark"><i data-lucide="calendar" class="icon-sm"></i></div>
          <div><div class="muted small">Acompanhando</div><div class="strong">${escapeHtml(watchLabel)}</div></div>
        </div>
      </div>
      <button type="button" class="btn block" id="ob-finish" style="margin-top:22px;padding:12px">
        <i data-lucide="refresh-cw" class="icon-sm"></i>Fazer a primeira atualização
      </button>
      <div class="muted small" style="text-align:center;margin-top:10px">Vou buscar os preços agora. Leva alguns segundos.</div>
      <div style="text-align:center;margin-top:14px"><button type="button" class="btn ghost small" id="ob-adjust">Ajustar</button></div>
    </div>`
    $('ob-adjust').addEventListener('click', () => { st.step = 3; render() })
    $('ob-finish').addEventListener('click', () => collecting())
    refreshIcons(host)
  }

  async function collecting () {
    host.innerHTML = `<div class="ob-card" style="text-align:center">
      <div class="ob-collect-ic"><i data-lucide="refresh-cw" class="icon-lg"></i></div>
      <h2 class="ob-h2" style="font-size:19px">Buscando os preços...</h2>
      <p class="ob-sub">Estou consultando os canais e comparando com o seu preço oficial. Já já aparece.</p>
      <div class="ob-progress"><span id="ob-bar" style="width:20%"></span></div>
      <div class="ob-checks" style="text-align:left">
        <div class="ob-checkline"><i data-lucide="check" class="icon-sm"></i>Encontrei o seu hotel</div>
        <div class="ob-checkline"><i data-lucide="check" class="icon-sm"></i>Li os preços dos canais</div>
        <div class="ob-checkline"><span class="spinner"></span>Comparando com o seu preço oficial</div>
      </div>
    </div>`
    refreshIcons(host)
    try {
      await api.runScan()
      const bar = $('ob-bar'); if (bar) setTimeout(() => { bar.style.width = '70%' }, 300)
      const scan = await waitForScan()
      if (opts.onDone) opts.onDone(scan)
    } catch (err) { toast(err.message, 'error'); if (opts.onClose) opts.onClose() }
  }

  const render = () => {
    if (st.step === 1) step1()
    else if (st.step === 2) step2()
    else if (st.step === 3) step3()
    else summary()
  }
  render()
}
