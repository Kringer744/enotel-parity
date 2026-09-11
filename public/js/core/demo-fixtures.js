/**
 * FIXTURES de DEMO — dados realistas da Enotel (Porto de Galinhas / Ipojuca-PE) para
 * o front rodar SEM backend (sem API, sem Postgres, sem gastar SerpAPI).
 *
 * Os numeros seguem o contexto real: Trip.com furando ~-37% (o pior e mais
 * consistente), Booking ~+25% acima, ~69 violacoes abertas / 23 criticas,
 * conformidade ~70%, orcamento 96/250 (projecao 191). As datas sao relativas a
 * "hoje" para o demo parecer sempre atual.
 *
 * Cada campo espelha o shape que `src/services/reports.js` devolve, entao o front
 * consome igual ao backend real. Ligue com `installDemo(api)` (uma linha).
 */

// ─── helpers ────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d }
const at0610 = (d) => { const x = new Date(d); x.setHours(6, 10, 0, 0); return x.toISOString() }
const rate = (base, offsetPct) => Math.round(base * (1 + offsetPct / 100))
const pct = (price, direct) => Math.round(((price - direct) / direct) * 1000) / 10

const TODAY = new Date()

// Canais monitorados (6 OTAs + site direto). offsetPct = posicao tipica vs. direto.
const CHANNELS = [
  { slug: 'direct', name: 'Enotel (site oficial)', color: '#0284c7', kind: 'direct', offsetPct: 0 },
  { slug: 'trip', name: 'Trip.com', color: '#f97316', kind: 'ota', offsetPct: -37 },
  { slug: 'maxmilhas', name: 'MaxMilhas', color: '#a855f7', kind: 'ota', offsetPct: -12 },
  { slug: 'hoteis', name: 'Hoteis.com', color: '#ef4444', kind: 'ota', offsetPct: -8 },
  { slug: 'expedia', name: 'Expedia', color: '#eab308', kind: 'ota', offsetPct: -3 },
  { slug: 'booking', name: 'Booking.com', color: '#2563eb', kind: 'ota', offsetPct: 25 },
  { slug: 'azul', name: 'Azul Viagens', color: '#14b8a6', kind: 'ota', offsetPct: 6 }
]
const OTAS = CHANNELS.filter((c) => c.kind === 'ota')
const bySlug = Object.fromEntries(CHANNELS.map((c) => [c.slug, c]))
const SEVERITY = { warning: 1, serious: 5, critical: 10 } // % de desconto
const sevFor = (deltaPct) => {
  const d = Math.abs(deltaPct)
  if (d >= SEVERITY.critical) return 'critical'
  if (d >= SEVERITY.serious) return 'serious'
  if (d >= SEVERITY.warning) return 'warning'
  return 'info'
}

// ─── blocos de tarifa atual (um por alvo ativo) ───────────────────────────────
// `absent`: OTAs que nao apareceram naquela data (viram missing_channel, cobertura
// irregular da fonte -- MaxMilhas/Azul aparecem de forma intermitente).
const BLOCKS = [
  { label: 'Curto prazo', mode: 'rolling', horizonDays: 7, inOffset: 7, los: 2, base: 1180, absent: ['azul'] },
  { label: 'Janela padrão', mode: 'rolling', horizonDays: 30, inOffset: 30, los: 2, base: 1090, absent: ['azul'] },
  { label: 'Planejamento', mode: 'rolling', horizonDays: 60, inOffset: 60, los: 2, base: 1010, absent: ['maxmilhas'] },
  { label: 'Fim de semana', mode: 'fixed', horizonDays: null, inOffset: 4, los: 2, base: 1320, absent: ['azul', 'maxmilhas'] },
  { label: 'Meio de semana', mode: 'fixed', horizonDays: null, inOffset: 11, los: 2, base: 980, absent: [] }
]

function buildCurrentRates () {
  return BLOCKS.map((b) => {
    const checkIn = addDays(TODAY, b.inOffset)
    const checkOut = addDays(checkIn, b.los)
    const direct = rate(b.base, 0)
    const offers = CHANNELS
      .filter((c) => c.kind === 'direct' || !b.absent.includes(c.slug))
      .map((c) => {
        const price = rate(b.base, c.offsetPct)
        return {
          slug: c.slug,
          name: c.name,
          color: c.color,
          kind: c.kind,
          price,
          deltaPct: c.kind === 'ota' ? pct(price, direct) : null
        }
      })
    return {
      checkIn: iso(checkIn),
      checkOut: iso(checkOut),
      los: b.los,
      targetLabel: b.label,
      horizonDays: b.horizonDays,
      mode: b.mode,
      directPrice: direct,
      offers
    }
  })
}

// ─── findings (undercuts) derivados dos blocos ────────────────────────────────
function buildFindings () {
  const out = []
  let id = 1
  const blocks = buildCurrentRates()
  blocks.forEach((blk, bi) => {
    const direct = blk.directPrice
    for (const o of blk.offers) {
      if (o.kind !== 'ota' || o.deltaPct === null || o.deltaPct >= -SEVERITY.warning) continue
      const ch = bySlug[o.slug]
      out.push({
        id: id++,
        created_at: at0610(addDays(TODAY, -(bi))),
        property_name: 'Enotel Convention & Spa Porto de Galinhas',
        channel_name: ch.name,
        channel_slug: ch.slug,
        channel_color: ch.color,
        kind: 'undercut',
        check_in: blk.checkIn,
        check_out: blk.checkOut,
        los: blk.los,
        base_price: direct,
        channel_price: o.price,
        delta_abs: o.price - direct,
        delta_pct: o.deltaPct,
        severity: sevFor(o.deltaPct),
        status: 'open',
        target_label: blk.targetLabel
      })
    }
  })
  // Ordena por severidade (o painel espera o pior no topo).
  const rank = { critical: 0, serious: 1, warning: 2, info: 3 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.delta_pct - b.delta_pct)
}

// ─── serie de tendencia (14 dias, alvo "Janela padrão") ───────────────────────
function buildTrend () {
  const days = 14
  const dates = Array.from({ length: days }, (_, i) => iso(addDays(TODAY, -(days - 1 - i))))
  const base = 1090
  const wobble = (i) => 1 + Math.sin(i / 2) * 0.03 // +-3% de variacao suave
  const series = CHANNELS.map((c) => ({
    slug: c.slug,
    name: c.name,
    color: c.color,
    kind: c.kind,
    values: dates.map((_, i) => rate(base * wobble(i), c.offsetPct))
  }))
  const targets = BLOCKS.map((b, i) => ({
    id: i + 1,
    label: b.label,
    mode: b.mode,
    checkIn: b.mode === 'fixed' ? iso(addDays(TODAY, b.inOffset)) : null
  }))
  return { target: targets[1], targets, dates, series }
}

// ─── conformidade por canal (30 dias) ─────────────────────────────────────────
function buildCompliance () {
  const comparisons = 30
  return OTAS.map((c) => {
    const violates = c.offsetPct < -SEVERITY.warning
    const violations = violates ? Math.round(comparisons * Math.min(0.95, Math.abs(c.offsetPct) / 40)) : 0
    return {
      slug: c.slug,
      name: c.name,
      color: c.color,
      comparisons,
      violations,
      avg_delta: violates ? c.offsetPct + 1.5 : null,
      worst_delta: violates ? c.offsetPct - 2 : null,
      complianceRate: Math.round(((comparisons - violations) / comparisons) * 1000) / 10
    }
  })
}

// ─── heatmap (violacoes por dia x canal, 12 dias) ─────────────────────────────
function buildHeatmap () {
  const out = []
  const violating = OTAS.filter((c) => c.offsetPct < -SEVERITY.warning)
  for (let i = 11; i >= 0; i--) {
    const day = iso(addDays(TODAY, -i))
    for (const c of violating) {
      // Trip.com fura quase todo dia; os demais, intermitente.
      const hits = c.slug === 'trip' ? 4 : (i % 2 === 0 ? 2 : 0)
      if (hits === 0) continue
      out.push({ day, slug: c.slug, name: c.name, violations: hits, worst_delta: c.offsetPct - 2 })
    }
  }
  return out
}

// ─── historico de varreduras (#21–#25, todas ok) ──────────────────────────────
function buildScans () {
  return [25, 24, 23, 22, 21].map((id, i) => {
    const started = addDays(TODAY, -i)
    return {
      id,
      trigger: 'schedule',
      status: 'ok',
      started_at: at0610(started),
      finished_at: at0610(started),
      requests_used: 5,
      targets_total: 5,
      targets_ok: 5,
      rates_captured: 18,
      findings_count: 9,
      message: null
    }
  })
}

// ─── overview (KPIs do topo) ──────────────────────────────────────────────────
function buildOverview (scans, budget) {
  const worst = { // o numero que dói: Trip.com no fim de semana
    delta_pct: -37,
    delta_abs: rate(1320, -37) - 1320,
    base_price: 1320,
    channel_price: rate(1320, -37),
    check_in: iso(addDays(TODAY, 4)),
    channel_name: 'Trip.com'
  }
  return {
    lastScan: scans[0],
    openBySeverity: { critical: 23, serious: 28, warning: 18, info: 0 },
    openTotal: 69,
    comparisons: 30,
    violations: 9,
    complianceRate: 70,
    worstGap: worst,
    budget
  }
}

// ─── orcamento SerpAPI (forecast) ─────────────────────────────────────────────
const daysLeftInMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0).getDate() - TODAY.getDate()
const budget = (() => {
  const used = 96
  const limit = 250
  const reserve = 25
  const perScan = 5
  const remaining = limit - used
  const scheduledRemaining = Math.max(0, remaining - reserve)
  return {
    month: `${TODAY.getFullYear()}-${pad(TODAY.getMonth() + 1)}`,
    used,
    limit,
    reserve,
    remaining,
    scheduledRemaining,
    pctUsed: Math.round((used / limit) * 1000) / 10,
    live: true,
    localUsed: used,
    providerUsage: used,
    providerLeft: remaining,
    planName: 'Free',
    accountEmail: 'ti@fluxodigitaltech.com.br',
    perScan,
    daysLeft: daysLeftInMonth,
    projected: used + perScan * daysLeftInMonth,
    willExceed: used + perScan * daysLeftInMonth > limit,
    maxTargetsPerScan: daysLeftInMonth > 0 ? Math.floor(scheduledRemaining / daysLeftInMonth) : perScan
  }
})()

// ─── propriedades e canais (telas de configuracao) ────────────────────────────
const properties = [{
  id: 1,
  tenant_id: 1,
  vertical: 'hotel',
  name: 'Enotel Convention & Spa Porto de Galinhas',
  serp_query: 'Enotel resort Ipojuca Pernambuco',
  serp_property_token: 'ChgIzcua6s28ueG-ARoLL2cvMXRtOGtzeGMQAQ',
  currency: 'BRL',
  active: true,
  targets: BLOCKS.map((b, i) => ({
    id: i + 1,
    label: b.label,
    mode: b.mode,
    horizon_days: b.horizonDays,
    los: b.los,
    adults: 2,
    active: true,
    check_in: b.mode === 'fixed' ? iso(addDays(TODAY, b.inOffset)) : null,
    check_out: b.mode === 'fixed' ? iso(addDays(TODAY, b.inOffset + b.los)) : null
  }))
}]

const channels = CHANNELS.map((c, i) => ({
  id: i + 1,
  tenant_id: 1,
  slug: c.slug,
  name: c.name,
  color: c.color,
  kind: c.kind,
  active: true,
  sort_order: i,
  patterns: [c.name.toLowerCase().split(' ')[0]]
}))

const me = { id: 1, email: 'admin@enotel.com.br', name: 'Administrador Enotel', role: 'tenant_admin', tenant_id: 1 }

// ─── monta o pacote ───────────────────────────────────────────────────────────
const scans = buildScans()
const currentRates = buildCurrentRates()
const findings = buildFindings()
const trend = buildTrend()
const compliance = buildCompliance()
const heatmap = buildHeatmap()
const overview = buildOverview(scans, budget)

export const demoFixtures = {
  me,
  overview,
  currentRates,
  trend,
  compliance,
  heatmap,
  findings,
  scans,
  budget,
  properties,
  channels,
  report: {
    generatedAt: new Date().toISOString(),
    periodDays: 30,
    overview,
    trend,
    compliance,
    heatmap,
    findings,
    currentRates,
    history: scans
  }
}

// ─── fixtures das telas de Configuracoes e WhatsApp ──────────────────────────
const demoSettings = {
  parity: { tolerance_pct: 1, tolerance_abs: 5, severity: { warning: 1, serious: 5, critical: 10 }, report_overcut: false, overcut_min_pct: 15 },
  notifications: { enabled: true, min_severity: 'warning', silent_when_clean: true },
  auto_targets: { enabled: true, adults: 2 }
}
const demoAuto = {
  enabled: true,
  adults: 2,
  periods: [
    { key: 'weekend', checkIn: iso(addDays(TODAY, 4)), checkOut: iso(addDays(TODAY, 6)) },
    { key: 'midweek', checkIn: iso(addDays(TODAY, 8)), checkOut: iso(addDays(TODAY, 10)) }
  ]
}
const demoDiagnose = {
  steps: [
    { ok: true, step: 'Conexao com a fonte de precos', detail: 'Chave ativa, plano Free' },
    { ok: true, step: 'Saldo real de atualizacoes', detail: '96 de 250 usadas neste mes' },
    { ok: true, step: 'Periodos ativos', detail: '5 periodos monitorados' },
    { ok: true, step: 'Ultima atualizacao', detail: 'concluida hoje as 06:10' }
  ],
  probe: null
}
const demoWa = {
  status: { configured: true, connected: true, instance: 'enotel-paridade', profileName: 'Enotel Reservas', number: '5581999990000' },
  contacts: [
    { jid: '5581999990001@s.whatsapp.net', name: 'Reservas Enotel', phone: '5581999990001', isGroup: false, image: null },
    { jid: '5581999990002@s.whatsapp.net', name: 'Revenue Management', phone: '5581999990002', isGroup: false, image: null },
    { jid: '120363000000000000@g.us', name: 'Paridade - Alertas', phone: '', isGroup: true, image: null }
  ],
  recipients: [
    { id: 1, name: 'Revenue Management', phone: '5581999990002', jid: '5581999990002@s.whatsapp.net', is_group: false, active: true },
    { id: 2, name: 'Paridade - Alertas', phone: '', jid: '120363000000000000@g.us', is_group: true, active: true }
  ],
  log: [
    { created_at: at0610(addDays(TODAY, -1)), recipient_name: 'Revenue Management', phone: '5581999990002', status: 'sent', error: null },
    { created_at: at0610(addDays(TODAY, -2)), recipient_name: 'Paridade - Alertas', phone: '', status: 'sent', error: null }
  ]
}

/**
 * Liga o modo demo: substitui os metodos de leitura do `api` por fixtures.
 * Uso no front (ex.: quando ?demo=1 ou sem backend):
 *   import { api } from './core/api.js'
 *   import { installDemo } from './core/demo-fixtures.js'
 *   installDemo(api)
 */
export function installDemo (api) {
  const val = (v) => () => Promise.resolve(v)
  Object.assign(api, {
    login: () => Promise.resolve({ token: 'demo-token', user: me }),
    me: val(me),
    overview: val(overview),
    trend: () => Promise.resolve(trend),
    compliance: () => Promise.resolve(compliance),
    heatmap: () => Promise.resolve(heatmap),
    findings: () => Promise.resolve(findings),
    updateFinding: () => Promise.resolve({ ok: true }),
    currentRates: val(currentRates),
    report: () => Promise.resolve(demoFixtures.report),
    scans: () => Promise.resolve(scans),
    runScan: () => Promise.resolve({ runs: [{ tenantId: 1, status: 'ok', spent: 5, ok: 5, rates: 18, findings: 9 }] }),
    budget: val(budget),
    budgetSync: () => Promise.resolve(budget),
    properties: val(properties),
    channels: val(channels),
    // --- Configuracoes ---
    settings: val(demoSettings),
    updateSettings: () => Promise.resolve({ ok: true }),
    autoPreview: val(demoAuto),
    autoGenerate: () => Promise.resolve({ generated: [] }),
    createTarget: () => Promise.resolve({ ok: true, id: Date.now() }),
    toggleTarget: () => Promise.resolve({ ok: true }),
    deleteTarget: () => Promise.resolve({ ok: true }),
    diagnose: val(demoDiagnose),
    // --- WhatsApp ---
    waStatus: val(demoWa.status),
    waInit: () => Promise.resolve({ ok: true }),
    waConnect: () => Promise.resolve({ qrcode: null, paircode: '482913' }),
    waDisconnect: () => Promise.resolve({ ok: true }),
    waContacts: val(demoWa.contacts),
    waRecipients: val(demoWa.recipients),
    waAddRecipient: () => Promise.resolve({ ok: true }),
    waToggleRecipient: () => Promise.resolve({ ok: true }),
    waRemoveRecipient: () => Promise.resolve({ ok: true }),
    waTest: () => Promise.resolve({ ok: true }),
    waNotifications: val(demoWa.log)
  })
  return api
}
