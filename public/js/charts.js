/* Gráficos em SVG nativo.
   Specs fixas: linha 2px, marcador >=8px com anel de 2px na cor da superfície,
   grade hairline sólida, barra <=24px com ponta arredondada de 4px, um único
   eixo, legenda sempre presente para 2+ séries, rótulos diretos seletivos.
   Texto nunca veste a cor da série — a identidade vem da marca colorida ao lado. */

import { refreshIcons } from './ui.js'

const NS = 'http://www.w3.org/2000/svg'

/** Estado vazio com ícone Lucide, já convertido em SVG. */
function renderEmpty (host, icon, text) {
  host.innerHTML = `<div class="empty"><i data-lucide="${icon}" class="empty-icon"></i>${text}</div>`
  refreshIcons(host)
}

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', maximumFractionDigits: 0
})
const BRL2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export const money = (v) => (v === null || v === undefined ? '—' : BRL.format(v))
export const money2 = (v) => (v === null || v === undefined ? '—' : BRL2.format(v))

function svgEl (tag, attrs = {}) {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) el.setAttribute(k, String(v))
  }
  return el
}

function surfaceColor () {
  return getComputedStyle(document.body).getPropertyValue('--surface').trim() || '#fff'
}

/** Escala de ticks "redondos" — 0 / 500 / 1.000, nunca 437,2. */
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

/** Redesenha quando o contêiner muda de largura — o SVG é em px, não escalado. */
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
    show (html, x, y) {
      tip.innerHTML = html
      tip.classList.add('visible')
      const w = tip.offsetWidth
      const hostW = host.clientWidth
      // Vira o balão para a esquerda quando esbarra na borda direita.
      let left = x + 14
      if (left + w > hostW) left = x - w - 14
      tip.style.left = `${Math.max(0, left)}px`
      tip.style.top = `${Math.max(0, y - 12)}px`
    },
    hide () { tip.classList.remove('visible') }
  }
}

function renderLegend (host, items, { square = false } = {}) {
  const old = host.parentElement.querySelector('.legend')
  if (old) old.remove()
  // Uma série única não ganha legenda: o título já a nomeia.
  if (items.length < 2) return
  const legend = document.createElement('div')
  legend.className = 'legend'
  legend.innerHTML = items.map((s) => `
    <span class="legend-item">
      <span class="legend-key${square ? ' square' : ''}" style="background:${s.color}"></span>
      ${s.name}
    </span>`).join('')
  host.parentElement.appendChild(legend)
}

/* ─── Gráfico de linhas com crosshair ─────────────────────────────────────── */

export function lineChart (host, { dates, series, height = 300, valueFmt = money }) {
  host.classList.add('chart')
  const live = series.filter((s) => s.values.some((v) => v !== null))

  if (dates.length === 0 || live.length === 0) {
    renderEmpty(host, 'trending-up', 'Sem dados no período. Rode uma varredura para começar a série.')
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

    const svg = svgEl('svg', { width, height, role: 'img' })
    const g = svgEl('g', { transform: `translate(${M.left},${M.top})` })
    svg.appendChild(g)

    for (const t of ticks) {
      g.appendChild(svgEl('line', { class: 'grid-line', x1: 0, x2: W, y1: y(t), y2: y(t) }))
      const label = svgEl('text', {
        class: 'tick-text', x: -10, y: y(t) + 3.5, 'text-anchor': 'end'
      })
      label.textContent = valueFmt(t)
      g.appendChild(label)
    }

    g.appendChild(svgEl('line', { class: 'axis-line', x1: 0, x2: W, y1: H, y2: H }))

    // Rótulos de data ralos: no máximo 7, senão colidem.
    const stride = Math.max(1, Math.ceil(dates.length / 7))
    dates.forEach((d, i) => {
      if (i % stride !== 0 && i !== dates.length - 1) return
      const t = svgEl('text', { class: 'tick-text', x: x(i), y: H + 18, 'text-anchor': 'middle' })
      t.textContent = fmtDay(d)
      g.appendChild(t)
    })

    // Uma série: acrescenta a lavagem de área a 10%.
    if (live.length === 1) {
      const s = live[0]
      const pts = s.values.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean)
      if (pts.length > 1) {
        const d = `M${pts[0][0]},${H} L` + pts.map((p) => p.join(',')).join(' L') +
                  ` L${pts[pts.length - 1][0]},${H} Z`
        g.appendChild(svgEl('path', { d, fill: s.color, 'fill-opacity': 0.10 }))
      }
    }

    for (const s of live) {
      // Segmentos separados: um dia sem coleta vira lacuna, não uma reta falsa.
      let run = []
      const flush = () => {
        if (run.length > 1) {
          g.appendChild(svgEl('path', {
            class: 'series-line',
            d: 'M' + run.map((p) => p.join(',')).join(' L'),
            stroke: s.color
          }))
        } else if (run.length === 1) {
          g.appendChild(svgEl('circle', {
            class: 'series-dot', cx: run[0][0], cy: run[0][1], r: 4, fill: s.color
          }))
        }
        run = []
      }
      s.values.forEach((v, i) => {
        if (v === null) flush()
        else run.push([x(i), y(v)])
      })
      flush()

      // Marcador só na ponta — um ponto por valor vira ruído.
      const lastIdx = s.values.reduce((acc, v, i) => (v !== null ? i : acc), -1)
      if (lastIdx >= 0) {
        g.appendChild(svgEl('circle', {
          class: 'series-dot', cx: x(lastIdx), cy: y(s.values[lastIdx]), r: 4.5, fill: s.color
        }))
      }
    }

    const crosshair = svgEl('line', { class: 'crosshair', y1: 0, y2: H, opacity: 0 })
    g.appendChild(crosshair)
    const hoverDots = svgEl('g', { opacity: 0 })
    g.appendChild(hoverDots)

    const tip = makeTooltip(host)
    const hit = svgEl('rect', { class: 'hit', x: 0, y: 0, width: W, height: H })
    g.appendChild(hit)

    hit.addEventListener('mousemove', (ev) => {
      const rect = svg.getBoundingClientRect()
      const px = ev.clientX - rect.left - M.left
      const i = Math.max(0, Math.min(dates.length - 1,
        Math.round((px / (W || 1)) * (dates.length - 1))))

      crosshair.setAttribute('x1', x(i))
      crosshair.setAttribute('x2', x(i))
      crosshair.setAttribute('opacity', 1)

      hoverDots.innerHTML = ''
      const rows = []
      for (const s of live) {
        const v = s.values[i]
        if (v === null) continue
        const dot = svgEl('circle', {
          class: 'series-dot', cx: x(i), cy: y(v), r: 4.5, fill: s.color
        })
        dot.setAttribute('stroke', surfaceColor())
        hoverDots.appendChild(dot)
        rows.push({ s, v })
      }
      hoverDots.setAttribute('opacity', 1)

      rows.sort((a, b) => a.v - b.v)
      tip.show(
        `<div class="tooltip-title">${fmtDay(dates[i])}</div>` +
        rows.map((r) => `
          <div class="tooltip-row">
            <span class="k" style="background:${r.s.color}"></span>
            <span>${r.s.name}</span>
            <span class="v">${money2(r.v)}</span>
          </div>`).join(''),
        x(i) + M.left, ev.clientY - svg.getBoundingClientRect().top
      )
    })

    hit.addEventListener('mouseleave', () => {
      crosshair.setAttribute('opacity', 0)
      hoverDots.setAttribute('opacity', 0)
      tip.hide()
    })

    host.querySelector('svg')?.remove()
    host.prepend(svg)
    renderLegend(host, live)
  })
}

/* ─── Barras horizontais ──────────────────────────────────────────────────── */

export function barChart (host, { items, height = null, valueFmt = (v) => `${v}%`, max = null }) {
  host.classList.add('chart')
  if (items.length === 0) {
    renderEmpty(host, 'bar-chart-3', 'Sem dados no período.')
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
    const g = svgEl('g', { transform: `translate(${M.left},${M.top})` })
    svg.appendChild(g)

    const tip = makeTooltip(host)

    items.forEach((item, idx) => {
      const cy = idx * rowH + rowH / 2
      const barH = 20                                  // <=24px: sobra vira ar
      const w = Math.max(2, (item.value / hi) * W)

      const label = svgEl('text', {
        class: 'tick-text', x: -12, y: cy + 4, 'text-anchor': 'end'
      })
      label.setAttribute('style', 'font-size:12px;fill:var(--ink-2)')
      label.textContent = item.name
      g.appendChild(label)

      // Trilho: passo mais claro da mesma rampa, para o estado ler na barra toda.
      g.appendChild(svgEl('rect', {
        x: 0, y: cy - barH / 2, width: W, height: barH, rx: 4,
        fill: item.color, 'fill-opacity': 0.10
      }))

      const bar = svgEl('rect', {
        x: 0, y: cy - barH / 2, width: w, height: barH, rx: 4,
        fill: item.color
      })
      g.appendChild(bar)

      // Rótulo direto na ponta, fora da barra — sempre cabe, nunca é cortado.
      const val = svgEl('text', {
        x: w + 10, y: cy + 4, 'text-anchor': 'start'
      })
      val.setAttribute('style', 'font-size:12px;font-weight:600;fill:var(--ink);font-variant-numeric:tabular-nums')
      val.textContent = valueFmt(item.value)
      g.appendChild(val)

      const hit = svgEl('rect', {
        class: 'hit', x: -M.left, y: cy - rowH / 2, width: width, height: rowH
      })
      g.appendChild(hit)
      hit.addEventListener('mousemove', (ev) => {
        tip.show(
          `<div class="tooltip-title">${item.name}</div>` +
          (item.detail || []).map((d) => `
            <div class="tooltip-row"><span>${d.label}</span><span class="v">${d.value}</span></div>
          `).join(''),
          ev.clientX - svg.getBoundingClientRect().left,
          cy + M.top
        )
      })
      hit.addEventListener('mouseleave', () => tip.hide())
    })

    host.querySelector('svg')?.remove()
    host.prepend(svg)
  })
}

/* ─── Heatmap sequencial ──────────────────────────────────────────────────── */

// Rampa azul 100→700 da paleta validada: uma só matiz, claro→escuro.
const BLUE_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']

export function heatmap (host, { rows, dates, valueKey = 'violations' }) {
  if (rows.length === 0 || dates.length === 0) {
    renderEmpty(host, 'calendar', 'Sem violações registradas no período.')
    return
  }

  const max = Math.max(...rows.flatMap((r) => dates.map((d) => r.cells[d] || 0)), 1)
  const step = (v) => (v === 0 ? null : BLUE_RAMP[Math.min(
    BLUE_RAMP.length - 1,
    Math.floor((v / max) * (BLUE_RAMP.length - 1) + 0.5)
  )])

  const table = document.createElement('div')
  table.style.display = 'grid'
  table.style.gridTemplateColumns = `140px repeat(${dates.length}, minmax(0, 1fr))`
  table.style.gap = '2px'
  table.style.alignItems = 'center'

  table.appendChild(document.createElement('div'))
  for (const d of dates) {
    const h = document.createElement('div')
    h.style.cssText = 'font-size:9.5px;color:var(--ink-3);text-align:center;font-variant-numeric:tabular-nums'
    h.textContent = new Date(`${d}T12:00:00Z`).getUTCDate()
    table.appendChild(h)
  }

  for (const r of rows) {
    const label = document.createElement('div')
    label.className = 'heat-row-label'
    label.innerHTML = `<span class="channel-swatch" style="background:${r.color}"></span>${r.name}`
    table.appendChild(label)

    for (const d of dates) {
      const v = r.cells[d] || 0
      const cell = document.createElement('div')
      cell.className = 'heat-cell'
      const bg = step(v)
      if (bg) {
        cell.style.background = bg
        // Rótulo dentro do preenchimento: branco ou tinta conforme a luminância.
        cell.style.color = v / max > 0.55 ? '#fff' : '#0b0b0b'
        cell.textContent = v
      }
      cell.title = `${r.name} · dia ${new Date(`${d}T12:00:00Z`).getUTCDate()}: ${v} violação(ões)`
      table.appendChild(cell)
    }
  }

  host.innerHTML = ''
  host.appendChild(table)

  const scale = document.createElement('div')
  scale.className = 'legend'
  scale.innerHTML =
    '<span class="legend-item muted small">Menos</span>' +
    BLUE_RAMP.map((c) => `<span class="legend-key square" style="background:${c};width:12px;height:12px"></span>`).join('') +
    '<span class="legend-item muted small">Mais violações</span>'
  host.appendChild(scale)
}
