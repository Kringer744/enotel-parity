import './helpers/env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchChannel, evaluate, severityRank, atLeast } from '../src/services/parity.js'

// Configuracao de paridade igual aos DEFAULTS de services/settings.js.
const SETTINGS = {
  parity: {
    tolerance_pct: 1.0,
    tolerance_abs: 5.0,
    severity: { warning: 1.0, serious: 5.0, critical: 10.0 },
    report_overcut: false,
    overcut_min_pct: 15.0
  }
}

const CHANNELS = [
  { id: 1, slug: 'enotel', kind: 'direct', patterns: ['enotel'] },
  { id: 2, slug: 'booking', kind: 'ota', patterns: ['booking'] },
  { id: 3, slug: 'azul-viagens', kind: 'ota', patterns: ['azul viagens', 'azul'] },
  { id: 4, slug: 'hoteis', kind: 'ota', patterns: ['hoteis.com', 'hoteis'] }
]

const direct = (price) => ({ channel: CHANNELS[0], price })
const ota = (id, price) => ({ channel: CHANNELS.find((c) => c.id === id), price })

test('matchChannel: o padrao mais longo vence (azul viagens > azul)', () => {
  const m = matchChannel('Azul Viagens', CHANNELS)
  assert.equal(m.slug, 'azul-viagens')
})

test('matchChannel: hoteis.com nao e capturado por padrao generico', () => {
  const m = matchChannel('Hoteis.com', CHANNELS)
  assert.equal(m.slug, 'hoteis')
})

test('matchChannel: casa Booking.com', () => {
  assert.equal(matchChannel('Booking.com', CHANNELS).slug, 'booking')
})

test('matchChannel: fonte desconhecida ou vazia devolve null', () => {
  assert.equal(matchChannel('Agencia Qualquer', CHANNELS), null)
  assert.equal(matchChannel('', CHANNELS), null)
  assert.equal(matchChannel(null, CHANNELS), null)
})

test('evaluate: undercut critico quando OTA >= 10% abaixo', () => {
  const [f] = evaluate([direct(1000), ota(2, 850)], SETTINGS)
  assert.equal(f.kind, 'undercut')
  assert.equal(f.severity, 'critical')
  assert.equal(f.deltaAbs, -150)
  assert.equal(f.deltaPct, -15)
  assert.equal(f.channelSlug, 'booking')
})

test('evaluate: faixas de severidade serious e warning', () => {
  const [serious] = evaluate([direct(1000), ota(2, 930)], SETTINGS) // -7%
  assert.equal(serious.severity, 'serious')
  const [warning] = evaluate([direct(1000), ota(2, 985)], SETTINGS) // -1.5%
  assert.equal(warning.severity, 'warning')
})

test('evaluate: tolerancia percentual silencia desvio minimo', () => {
  // -0.5% e -R$5 -> dentro da tolerancia percentual (<1%)
  const findings = evaluate([direct(1000), ota(2, 995)], SETTINGS)
  assert.equal(findings.length, 0)
})

test('evaluate: tolerancia absoluta silencia diferenca de poucos reais', () => {
  // -4% (fora da tolerancia %) mas -R$4 (dentro da tolerancia absoluta <R$5)
  const findings = evaluate([direct(100), ota(2, 96)], SETTINGS)
  assert.equal(findings.length, 0)
})

test('evaluate: sem tarifa direta gera missing_direct (nao inventa conformidade)', () => {
  const findings = evaluate([ota(2, 850), ota(3, 700)], SETTINGS)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'missing_direct')
  assert.equal(findings[0].severity, 'warning')
  assert.equal(findings[0].basePrice, null)
})

test('evaluate: OTA acima da ancora nao vira achado com report_overcut desligado', () => {
  const findings = evaluate([direct(1000), ota(2, 1300)], SETTINGS)
  assert.equal(findings.length, 0)
})

test('evaluate: overcut so reportado acima do minimo quando ligado', () => {
  const cfg = { parity: { ...SETTINGS.parity, report_overcut: true } }
  const acima = evaluate([direct(1000), ota(2, 1200)], cfg) // +20% >= 15
  assert.equal(acima[0].kind, 'overcut')
  assert.equal(acima[0].severity, 'info')
  const pouco = evaluate([direct(1000), ota(2, 1100)], cfg) // +10% < 15 -> ignora
  assert.equal(pouco.length, 0)
})

test('evaluate: sem OTAs (so direto) nao gera achado', () => {
  assert.equal(evaluate([direct(1000)], SETTINGS).length, 0)
})

test('severityRank / atLeast respeitam a ordem info<warning<serious<critical', () => {
  assert.ok(severityRank('critical') > severityRank('warning'))
  assert.equal(atLeast('critical', 'warning'), true)
  assert.equal(atLeast('info', 'warning'), false)
  assert.equal(atLeast('warning', 'warning'), true)
})
