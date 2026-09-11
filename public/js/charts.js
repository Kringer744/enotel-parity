/* Biblioteca de graficos em SVG nativo (sem lib externa).
   Formas: lineChart (crosshair), barChart, heatmap, sparkline, divergingBars.

   Tres contratos, iguais em todas as formas:
   - COR por SLOT: cada serie/item aceita { slot: 1..8 } -> a marca recebe estilo
     inline referenciando var(--series-N); trocar tema/tenant repinta o SVG sozinho,
     sem redraw. { color:'#hex' } segue valido como fallback de compatibilidade.
     O heatmap usa a rampa sequencial var(--seq-100..700) (azul fixo da plataforma).
   - SEGURANCA: todo nome/rotulo entra por textContent (nunca innerHTML com
     interpolacao) -- em multi-tenant, nome de canal/subject e entrada do tenant.
   - ACESSIBILIDADE: <svg role=img aria-label> + <title>; foco por teclado espelha
     o hover (crosshair navegavel por setas; marcas focalizaveis com tabindex);
     toda forma com plot ganha uma tabela-gemea (buildTable) para leitor de tela
     e para o botao "Ver tabela" (toggleTable).

   Specs visuais fixas: linha 2px, marcador >=8px com anel de 2px na cor da
   superficie (via classe .series-dot), grade hairline solida, barra <=24px com
   ponta arredondada de 4px, um unico eixo, legenda so para 2+ series, rotulos
   diretos seletivos. Texto nunca veste a cor da serie -- a identidade vem da
   marca colorida ao lado. */

import { refreshIcons } from './ui.js'

const NS = 'http://www.w3.org/2000/svg'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

/* ─── Estilo e texto seguro ────────────────────────────────────────────────── */

/** Cor de uma serie/item: slot -> var(--series-N); senao hex legado; fallback 1. */
function markPaint (target) {
  if (target && target.slot) return `var(--series-${target.slot})`
  if (target && target.color) return target.color
  return 'var(--series-1)'
}

/** Passo da rampa sequencial (azul fixo da plataforma, CVD-safe). */
const seqVar = (step) => `var(--seq-${step})`

/** Escreve texto com seguranca (nunca interpreta HTML). */
function setText (el, value) {
  el.textContent = value === null || value === undefined ? '' : String(value)
  return el
}

function svgEl (tag, attrs = {}) {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) el.setAttribute(k, String(v))
  }
  return el
}

/** role=img + aria-label + <title> para leitores de tela. */
function mountAria (svg, label) {
  svg.setAttribute('role', 'img')
  if (label) {
    svg.setAttribute('aria-label', label)
    const t = svgEl('title')
    setText(t, label)
    svg.insertBefore(t, svg.firstChild)
  }
}

/* ─── Tabela-gemea (equivalente WCAG) ──────────────────────────────────────── */

const SR_ONLY = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;' +
  'overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;'
const TABLE_SHOWN = 'display:table;width:100%;border-collapse:collapse;' +
  'margin-top:12px;font-size:12.5px'

/**
 * Constroi a tabela-gemea: os mesmos numeros do grafico em texto. Nasce
 * escondida (sr-only, lida por leitor de tela); toggleTable a exibe.
 * columns: string[] · rows: (string|number)[][] (primeira celula vira <th scope=row>).
 */
function buildTable ({ caption, columns, rows }) {
  const table = document.createElement('table')
  table.className = 'chart-table'
  table.dataset.shown = '0'
  table.setAttribute('style', SR_ONLY)
  if (caption) setText(table.createCaption(), caption)

  const hr = table.createTHead().insertRow()
  for (const c of columns) {
    const th = document.createElement('th')
    th.scope = 'col'
    setText(th, c)
    hr.appendChild(th)
  }

  const tbody = table.createTBody()
  for (const r of rows) {
    const tr = tbody.insertRow()
    r.forEach((cell, i) => {
      if (i === 0) {
        const th = document.createElement('th')
        th.scope = 'row'
        setText(th, cell)
        tr.appendChild(th)
      } else {
        setText(tr.insertCell(), cell)
      }
    })
  }
  return table
}

/**
 * Mostra/esconde a tabela-gemea de um grafico. Sem argumento, alterna.
 * O card com o botao "Ver tabela" chama toggleTable(host).
 */
export function toggleTable (host, show) {
  const t = host.querySelector('.chart-table')
  if (!t) return null
  const next = show === undefined ? t.dataset.shown !== '1' : Boolean(show)
  t.dataset.shown = next ? '1' : '0'
  t.setAttribute('style', next ? TABLE_SHOWN : SR_ONLY)
  return next
}

/* ─── Infra de desenho ─────────────────────────────────────────────────────── */

/** Estado vazio com icone Lucide, ja convertido em SVG. */
function renderEmpty (host, icon, text) {
  const box = document.createElement('div')
  box.className = 'empty'
  const i = document.createElement('i')
  i.setAttribute('data-lucide', icon)
  i.className = 'empty-icon'
  box.appendChild(i)
  box.appendChild(setText(document.createElement('span'), text))
  host.replaceChildren(box)
  refreshIcons(host)
}

/**
 * Esvazia o conteiner antes de desenhar, preservando so o tooltip (que e
 * reaproveitado entre redesenhos). Sem isto o esqueleto de carregamento e o
 * SVG anterior ficam empilhados embaixo do grafico.
 */
function clearChart (host) {
  for (const child of [...host.children]) {
    if (!child.classList.contains('tooltip')) child.remove()
  }
}

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', maximumFractionDigits: 0
})
const BRL2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export const money = (v) => (v === null || v === undefined ? '—' : BRL.format(v))
export const money2 = (v) => (v === null || v === undefined ? '—' : BRL2.format(v))

/** Escala de ticks "redondos" -- 0 / 500 / 1.000, nunca 437,2. */
function niceTicks (min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const base = Number.isFinite(max) ? max : 100
    return { ticks: [0, base || 100], lo: 0, hi: base || 100 }
  }
  const raw = (max - min) / (count - 1)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks = []
  for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100)
  return { ticks, lo, hi }
}

function fmtDay (iso) {
  const d = new Date(`${iso}T12:00:00Z`)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' })
    .replace('.', '')
}

/** Redesenha quando o conteiner muda de largura -- o SVG e em px, nao escalado. */
function responsive (host, draw) {
  let last = 0
  const run = () => {
    const w = host.clientWidth
    if (w > 0 && Math.abs(w - last) > 2) { last = w; draw(w) }
  }
  run()
  if (host._ro) host._ro.disconnect()
  host._ro = new ResizeObserver(run)
  host._ro.observe(host)
}

function makeTooltip (host) {
  let tip = host.querySelector('.tooltip')
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'tooltip'
    host.appendChild(tip)
  }
  return {
    show (content, x, y) {
      tip.replaceChildren(content)
      tip.classList.add('visible')
      const w = tip.offsetWidth
      const hostW = host.clientWidth
      // Vira o balao para a esquerda quando esbarra na borda direita.
      let left = x + 14
      if (left + w > hostW) left = x - w - 14
      tip.style.left = `${Math.max(0, left)}px`
      tip.style.top = `${Math.max(0, y - 12)}px`
    },
    hide () { tip.classList.remove('visible') }
  }
}

/* Blocos de tooltip construidos com DOM seguro (nomes por textContent). */
function tipTitle (text) {
  const d = document.createElement('div')
  d.className = 'tooltip-title'
  return setText(d, text)
}
function tipRow ({ key, label, value }) {
  const row = document.createElement('div')
  row.className = 'tooltip-row'
  if (key) {
    const k = document.createElement('span')
    k.className = 'k'
    k.style.background = key
    row.appendChild(k)
  }
  row.appendChild(setText(document.createElement('span'), label))
  const v = setText(document.createElement('span'), value)
  v.className = 'v'
  row.appendChild(v)
  return row
}
function frag (...nodes) {
  const f = document.createDocumentFragment()
  for (const n of nodes) if (n) f.appendChild(n)
  return f
}

function renderLegend (host, items, { square = false } = {}) {
  const parent = host.parentElement
  const old = parent && parent.querySelector('.legend')
  if (old) old.remove()
  // Uma serie unica nao ganha legenda: o titulo ja a nomeia.
  if (items.length < 2 || !parent) return
  const legend = document.createElement('div')
  legend.className = 'legend'
  for (const s of items) {
    const item = document.createElement('span')
    item.className = 'legend-item'
    const key = document.createElement('span')
    key.className = 'legend-key' + (square ? ' square' : '')
    key.style.background = markPaint(s)
    item.appendChild(key)
    item.appendChild(setText(document.createElement('span'), s.name))
    legend.appendChild(item)
  }
  parent.appendChild(legend)
}

/* ─── Grafico de linhas com crosshair ─────────────────────────────────────── */

export function lineChart (host, { dates, series, height = 300, valueFmt = money, ariaLabel }) {
  host.classList.add('chart')
  const live = series.filter((s) => s.values.some((v) => v !== null))

  if (dates.length === 0 || live.length === 0) {
    renderEmpty(host, 'trending-up', 'Sem dados no periodo. Rode uma varredura para comecar a serie.')
    return
  }

  responsive(host, (width) => {
    const M = { top: 14, right: 18, bottom: 30, left: 56 }
    const W = width - M.left - M.right
    const H = height - M.top - M.bottom

    const all = live.flatMap((s) => s.values).filter((v) => v !== null)
    const { ticks, lo, hi } = niceTicks(Math.min(...all), Math.max(...all))
    const x = (i) => (dates.length === 1 ? W / 2 : (i / (dates.length - 1)) * W)
    const y = (v) => H - ((v - lo) / (hi - lo || 1)) * H

    const svg = svgEl('svg', { width, height })
    mountAria(svg, ariaLabel ||
      `Tendencia: ${live.length} ${live.length === 1 ? 'serie' : 'series'}, ` +
      `${dates.length} ${dates.length === 1 ? 'data' : 'datas'}, ` +
      `de ${valueFmt(lo)} a ${valueFmt(hi)}`)
    const g = svgEl('g', { transform: `translate(${M.left},${M.top})` })
    svg.appendChild(g)

    for (const t of ticks) {
      g.appendChild(svgEl('line', { class: 'grid-line', x1: 0, x2: W, y1: y(t), y2: y(t) }))
      const label = svgEl('text', { class: 'tick-text', x: -10, y: y(t) + 3.5, 'text-anchor': 'end' })
      setText(label, valueFmt(t))
      g.appendChild(label)
    }

    g.appendChild(svgEl('line', { class: 'axis-line', x1: 0, x2: W, y1: H, y2: H }))

    // Rotulos de data ralos: no maximo 7, senao colidem.
    const stride = Math.max(1, Math.ceil(dates.length / 7))
    dates.forEach((d, i) => {
      if (i % stride !== 0 && i !== dates.length - 1) return
      const t = svgEl('text', { class: 'tick-text', x: x(i), y: H + 18, 'text-anchor': 'middle' })
      setText(t, fmtDay(d))
      g.appendChild(t)
    })

    // Uma serie: acrescenta a lavagem de area a 10%.
    if (live.length === 1) {
      const s = live[0]
      const pts = s.values.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean)
      if (pts.length > 1) {
        const d = `M${pts[0][0]},${H} L` + pts.map((p) => p.join(',')).join(' L') +
                  ` L${pts[pts.length - 1][0]},${H} Z`
        const area = svgEl('path', { d, 'fill-opacity': 0.10 })
        area.style.fill = markPaint(s)
        g.appendChild(area)
      }
    }

    for (const s of live) {
      // Segmentos separados: um dia sem coleta vira lacuna, nao uma reta falsa.
      let run = []
      const flush = () => {
        if (run.length > 1) {
          const path = svgEl('path', { class: 'series-line', d: 'M' + run.map((p) => p.join(',')).join(' L') })
          path.style.stroke = markPaint(s)
          g.appendChild(path)
        } else if (run.length === 1) {
          const dot = svgEl('circle', { class: 'series-dot', cx: run[0][0], cy: run[0][1], r: 4 })
          dot.style.fill = markPaint(s)
          g.appendChild(dot)
        }
        run = []
      }
      s.values.forEach((v, i) => {
        if (v === null) flush()
        else run.push([x(i), y(v)])
      })
      flush()

      // Marcador so na ponta -- um ponto por valor vira ruido.
      const lastIdx = s.values.reduce((acc, v, i) => (v !== null ? i : acc), -1)
      if (lastIdx >= 0) {
        const dot = svgEl('circle', { class: 'series-dot', cx: x(lastIdx), cy: y(s.values[lastIdx]), r: 4.5 })
        dot.style.fill = markPaint(s)
        g.appendChild(dot)
      }
    }

    const crosshair = svgEl('line', { class: 'crosshair', y1: 0, y2: H, opacity: 0 })
    g.appendChild(crosshair)
    const hoverDots = svgEl('g', { opacity: 0 })
    g.appendChild(hoverDots)

    const tip = makeTooltip(host)
    const hit = svgEl('rect', { class: 'hit', x: 0, y: 0, width: W, height: H })
    g.appendChild(hit)

    let curIdx = -1
    const update = (i, pointerY) => {
      curIdx = i
      crosshair.setAttribute('x1', x(i))
      crosshair.setAttribute('x2', x(i))
      crosshair.setAttribute('opacity', 1)

      hoverDots.replaceChildren()
      const rows = []
      for (const s of live) {
        const v = s.values[i]
        if (v === null || v === undefined) continue
        const dot = svgEl('circle', { class: 'series-dot', cx: x(i), cy: y(v), r: 4.5 })
        dot.style.fill = markPaint(s)
        hoverDots.appendChild(dot)
        rows.push({ s, v })
      }
      hoverDots.setAttribute('opacity', 1)

      rows.sort((a, b) => a.v - b.v)
      const content = frag(
        tipTitle(fmtDay(dates[i])),
        ...rows.map((r) => tipRow({ key: markPaint(r.s), label: r.s.name, value: money2(r.v) }))
      )
      const yPos = pointerY !== null && pointerY !== undefined
        ? pointerY
        : (rows.length ? y(rows[0].v) + M.top : M.top)
      tip.show(content, x(i) + M.left, yPos)
    }
    const clear = () => {
      curIdx = -1
      crosshair.setAttribute('opacity', 0)
      hoverDots.setAttribute('opacity', 0)
      tip.hide()
    }

    hit.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect()
      const px = ev.clientX - rect.left - M.left
      update(clamp(Math.round((px / (W || 1)) * (dates.length - 1)), 0, dates.length - 1),
        ev.clientY - rect.top)
    })
    hit.addEventListener('pointerleave', clear)

    // Teclado: o grafico e focalizavel; setas movem o crosshair, foco espelha hover.
    host.setAttribute('tabindex', '0')
    host.onkeydown = (ev) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return
      ev.preventDefault()
      let i = curIdx < 0 ? 0 : curIdx
      if (ev.key === 'ArrowLeft') i = Math.max(0, i - 1)
      else if (ev.key === 'ArrowRight') i = Math.min(dates.length - 1, i + 1)
      else if (ev.key === 'Home') i = 0
      else i = dates.length - 1
      update(i, null)
    }
    host.onblur = clear

    const table = buildTable({
      caption: ariaLabel || 'Tendencia de preco',
      columns: ['Data', ...live.map((s) => s.name)],
      rows: dates.map((d, i) => [fmtDay(d), ...live.map((s) => money2(s.values[i]))])
    })

    clearChart(host)
    host.prepend(svg)
    host.append(table)
    renderLegend(host, live)
  })
}

/* ─── Barras horizontais (magnitude) ──────────────────────────────────────── */

export function barChart (host, { items, height = null, valueFmt = (v) => `${v}%`, max = null, ariaLabel }) {
  host.classList.add('chart')
  if (items.length === 0) {
    renderEmpty(host, 'bar-chart-3', 'Sem dados no periodo.')
    return
  }

  responsive(host, (width) => {
    const rowH = 34
    const M = { top: 6, right: 66, bottom: 6, left: 132 }
    const H = items.length * rowH
    const total = height || H + M.top + M.bottom
    const W = Math.max(60, width - M.left - M.right)
    const hi = max ?? Math.max(...items.map((i) => i.value), 1)

    const svg = svgEl('svg', { width, height: total })
    mountAria(svg, ariaLabel || `Barras: ${items.length} ${items.length === 1 ? 'item' : 'itens'}`)
    const g = svgEl('g', { transform: `translate(${M.left},${M.top})` })
    svg.appendChild(g)

    const tip = makeTooltip(host)

    items.forEach((item, idx) => {
      const cy = idx * rowH + rowH / 2
      const barH = 20                                  // <=24px: sobra vira ar
      const w = Math.max(2, (item.value / hi) * W)
      const paint = markPaint(item)

      const label = svgEl('text', { class: 'tick-text', x: -12, y: cy + 4, 'text-anchor': 'end' })
      label.setAttribute('style', 'font-size:12px;fill:var(--ink-2)')
      setText(label, item.name)
      g.appendChild(label)

      // Trilho: mesma matiz a 10%, para o estado ler na barra toda.
      const rail = svgEl('rect', { x: 0, y: cy - barH / 2, width: W, height: barH, rx: 4, 'fill-opacity': 0.10 })
      rail.style.fill = paint
      g.appendChild(rail)

      const bar = svgEl('rect', { x: 0, y: cy - barH / 2, width: w, height: barH, rx: 4 })
      bar.style.fill = paint
      g.appendChild(bar)

      // Rotulo direto na ponta, fora da barra -- sempre cabe, nunca e cortado.
      const val = svgEl('text', { x: w + 10, y: cy + 4, 'text-anchor': 'start' })
      val.setAttribute('style', 'font-size:12px;font-weight:600;fill:var(--ink);font-variant-numeric:tabular-nums')
      setText(val, valueFmt(item.value))
      g.appendChild(val)

      const hit = svgEl('rect', { class: 'hit', x: -M.left, y: cy - rowH / 2, width, height: rowH })
      hit.setAttribute('tabindex', '0')
      hit.setAttribute('role', 'img')
      hit.setAttribute('aria-label', `${item.name}: ${valueFmt(item.value)}`)
      g.appendChild(hit)

      const show = (clientX) => tip.show(
        frag(
          tipTitle(item.name),
          ...(item.detail || []).map((d) => tipRow({ label: d.label, value: d.value }))
        ),
        clientX !== null && clientX !== undefined ? clientX : M.left + w,
        cy + M.top
      )
      hit.addEventListener('pointermove', (ev) => show(ev.clientX - svg.getBoundingClientRect().left))
      hit.addEventListener('pointerleave', () => tip.hide())
      hit.addEventListener('focus', () => show(null))
      hit.addEventListener('blur', () => tip.hide())
    })

    const table = buildTable({
      caption: ariaLabel || 'Valores por item',
      columns: ['Item', 'Valor'],
      rows: items.map((it) => [it.name, valueFmt(it.value)])
    })

    clearChart(host)
    host.prepend(svg)
    host.append(table)
  })
}

/* ─── Barras divergentes (desvio em torno de uma ancora) ──────────────────── */

/**
 * Primitiva: so a geometria da barra divergente. value e o desvio com sinal em
 * torno de `origin` -- negativo cai no polo `negColor`, positivo no `posColor`
 * (par divergente azul<->vermelho da paleta; zero neutro no eixo central).
 * Badges/status/estado-vazio/colapso responsivo ficam na composicao do chamador.
 */
export function divergingBars (host, {
  items, origin = 0, scale = null, height = null,
  valueFmt = (v) => `${v}`, negColor = 'var(--series-8)', posColor = 'var(--series-1)', ariaLabel
}) {
  host.classList.add('chart')
  if (!items || items.length === 0) {
    renderEmpty(host, 'bar-chart-3', 'Sem dados no periodo.')
    return
  }

  responsive(host, (width) => {
    const rowH = 34
    const M = { top: 6, right: 56, bottom: 6, left: 132 }
    const H = items.length * rowH
    const total = height || H + M.top + M.bottom
    const W = Math.max(60, width - M.left - M.right)
    const span = scale ?? Math.max(...items.map((i) => Math.abs(i.value - origin)), 1)
    const mid = W / 2
    const unit = mid / (span || 1)
    const barH = 20

    const svg = svgEl('svg', { width, height: total })
    mountAria(svg, ariaLabel || `Desvio por item: ${items.length} ${items.length === 1 ? 'item' : 'itens'}`)
    const g = svgEl('g', { transform: `translate(${M.left},${M.top})` })
    svg.appendChild(g)

    // Eixo central = zero neutro (a ancora).
    g.appendChild(svgEl('line', { class: 'axis-line', x1: mid, x2: mid, y1: 0, y2: H }))

    const tip = makeTooltip(host)

    items.forEach((item, idx) => {
      const cy = idx * rowH + rowH / 2
      const d = item.value - origin
      const w = Math.abs(d) * unit
      const bx = d < 0 ? mid - w : mid

      const label = svgEl('text', { class: 'tick-text', x: -12, y: cy + 4, 'text-anchor': 'end' })
      label.setAttribute('style', 'font-size:12px;fill:var(--ink-2)')
      setText(label, item.name)
      g.appendChild(label)

      const bar = svgEl('rect', { x: bx, y: cy - barH / 2, width: Math.max(2, w), height: barH, rx: 4 })
      bar.style.fill = item.slot ? markPaint(item) : (d < 0 ? negColor : posColor)
      g.appendChild(bar)

      const val = svgEl('text', {
        y: cy + 4,
        'text-anchor': d < 0 ? 'end' : 'start',
        x: d < 0 ? bx - 8 : bx + w + 8
      })
      val.setAttribute('style', 'font-size:12px;font-weight:600;fill:var(--ink);font-variant-numeric:tabular-nums')
      setText(val, valueFmt(item.value))
      g.appendChild(val)

      const hit = svgEl('rect', { class: 'hit', x: -M.left, y: cy - rowH / 2, width, height: rowH })
      hit.setAttribute('tabindex', '0')
      hit.setAttribute('role', 'img')
      hit.setAttribute('aria-label', `${item.name}: ${valueFmt(item.value)}`)
      g.appendChild(hit)

      const show = (clientX) => tip.show(
        frag(tipTitle(item.name), tipRow({ label: 'Desvio', value: valueFmt(item.value) })),
        clientX !== null && clientX !== undefined ? clientX : M.left + bx + (d < 0 ? 0 : w),
        cy + M.top
      )
      hit.addEventListener('pointermove', (ev) => show(ev.clientX - svg.getBoundingClientRect().left))
      hit.addEventListener('pointerleave', () => tip.hide())
      hit.addEventListener('focus', () => show(null))
      hit.addEventListener('blur', () => tip.hide())
    })

    const table = buildTable({
      caption: ariaLabel || 'Desvio por item',
      columns: ['Item', 'Desvio'],
      rows: items.map((it) => [it.name, valueFmt(it.value)])
    })

    clearChart(host)
    host.append(table)
    host.prepend(svg)
  })
}

/* ─── Sparkline (figura de tendencia para stat tiles) ─────────────────────── */

/**
 * Mini-linha sem eixo/grade/tooltip -- e figura, nao plot. Respeita null (lacuna).
 * Linha no tom de-enfase (serie a 50%), ponta atual no tom cheio (accent).
 * Por padrao aria-hidden: num stat tile, o numero da tile e o conteudo acessivel.
 */
export function sparkline (host, { values, slot = 1, height = 32, highlightLast = true, ariaLabel }) {
  host.classList.add('chart')
  const nums = (values || []).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
  const live = nums.filter((v) => v !== null)

  responsive(host, (width) => {
    if (live.length === 0) { host.replaceChildren(); return }
    const w = Math.max(40, width)
    const h = height
    const pad = 3
    const lo = Math.min(...live)
    const hi = Math.max(...live)
    const x = (i) => (nums.length === 1 ? w / 2 : pad + (i / (nums.length - 1)) * (w - 2 * pad))
    const y = (v) => (h - pad) - ((v - lo) / ((hi - lo) || 1)) * (h - 2 * pad)
    const paint = `var(--series-${slot})`

    const svg = svgEl('svg', { width: w, height: h })
    if (ariaLabel) mountAria(svg, ariaLabel)
    else svg.setAttribute('aria-hidden', 'true')

    let run = []
    const flush = () => {
      if (run.length > 1) {
        const p = svgEl('path', { class: 'series-line', d: 'M' + run.map((pt) => pt.join(',')).join(' L') })
        p.style.stroke = paint
        p.style.strokeOpacity = '0.5'
        svg.appendChild(p)
      }
      run = []
    }
    nums.forEach((v, i) => { if (v === null) flush(); else run.push([x(i), y(v)]) })
    flush()

    if (highlightLast) {
      const lastIdx = nums.reduce((acc, v, i) => (v !== null ? i : acc), -1)
      if (lastIdx >= 0) {
        const dot = svgEl('circle', { class: 'series-dot', cx: x(lastIdx), cy: y(nums[lastIdx]), r: 3 })
        dot.style.fill = paint
        svg.appendChild(dot)
      }
    }

    host.replaceChildren(svg)
  })
}

/* ─── Heatmap sequencial ──────────────────────────────────────────────────── */

// Passos da rampa sequencial (tokens --seq-*): claro->escuro, uma so matiz.
const RAMP_STEPS = [100, 200, 300, 400, 500, 600, 700]

export function heatmap (host, { rows, dates, valueKey = 'violations', scaleLabel, ariaLabel }) {
  void valueKey
  if (rows.length === 0 || dates.length === 0) {
    renderEmpty(host, 'calendar', 'Sem violacoes registradas no periodo.')
    return
  }

  const max = Math.max(...rows.flatMap((r) => dates.map((d) => r.cells[d] || 0)), 1)
  const bucket = (v) => Math.min(
    RAMP_STEPS.length - 1,
    Math.floor((v / max) * (RAMP_STEPS.length - 1) + 0.5)
  )

  const table = document.createElement('div')
  table.setAttribute('role', 'img')
  table.setAttribute('aria-label', ariaLabel ||
    `Mapa de calor: ${rows.length} canais x ${dates.length} dias`)
  table.style.display = 'grid'
  table.style.gridTemplateColumns = `140px repeat(${dates.length}, minmax(0, 1fr))`
  table.style.gap = '2px'
  table.style.alignItems = 'center'

  table.appendChild(document.createElement('div'))
  for (const d of dates) {
    const h = document.createElement('div')
    h.style.cssText = 'font-size:9.5px;color:var(--ink-3);text-align:center;font-variant-numeric:tabular-nums'
    setText(h, new Date(`${d}T12:00:00Z`).getUTCDate())
    table.appendChild(h)
  }

  for (const r of rows) {
    const label = document.createElement('div')
    label.className = 'heat-row-label'
    const swatch = document.createElement('span')
    swatch.className = 'channel-swatch'
    swatch.style.background = markPaint(r)
    label.appendChild(swatch)
    label.appendChild(setText(document.createElement('span'), r.name))
    table.appendChild(label)

    for (const d of dates) {
      const v = r.cells[d] || 0
      const cell = document.createElement('div')
      cell.className = 'heat-cell'
      if (v > 0) {
        const idx = bucket(v)
        cell.style.background = seqVar(RAMP_STEPS[idx])
        // No escuro os passos mais escuros somem na superficie: um anel (token
        // --heat-cell-ring = transparent no claro, hairline no escuro) separa a
        // celula do fundo sem alterar layout nem exigir redraw no toggle.
        cell.style.boxShadow = 'inset 0 0 0 1px var(--heat-cell-ring)'
        // Rotulo dentro do preenchimento: branco nos passos escuros, tinta nos claros.
        // Amarrado ao passo pintado (nao a um limiar solto) para nunca desencontrar.
        cell.style.color = idx >= 4 ? '#fff' : '#0b0b0b'
        setText(cell, v)
      }
      const dia = new Date(`${d}T12:00:00Z`).getUTCDate()
      cell.title = `${r.name} · dia ${dia}: ${v} violacao(oes)`
      table.appendChild(cell)
    }
  }

  host.replaceChildren(table)

  const scale = document.createElement('div')
  scale.className = 'legend'
  const less = document.createElement('span')
  less.className = 'legend-item muted small'
  setText(less, (scaleLabel && scaleLabel.min) || 'Menos')
  scale.appendChild(less)
  for (const step of RAMP_STEPS) {
    const key = document.createElement('span')
    key.className = 'legend-key square'
    key.style.cssText = 'width:12px;height:12px'
    key.style.background = seqVar(step)
    scale.appendChild(key)
  }
  const more = document.createElement('span')
  more.className = 'legend-item muted small'
  setText(more, (scaleLabel && scaleLabel.max) || 'Mais violacoes')
  scale.appendChild(more)
  host.appendChild(scale)
}
