import './helpers/env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pct, fmtDate, fmtDateTime, fmtRelative } from '../public/js/ui.js'
import { money, money2 } from '../public/js/charts.js'

// PRD (Bussola) B1-CA2 / §6.4: "sem dado" aparece como "—", NUNCA como 0.
// Guardrail de confiabilidade de leitura: 0 ocorrencia de "sem dado" como "0".

const DASH = '—'

test('pct: null/undefined viram "—" (nao 0%); zero real continua 0,0%', () => {
  assert.equal(pct(null), DASH)
  assert.equal(pct(undefined), DASH)
  assert.notEqual(pct(null), '0,0%')
  assert.equal(pct(0), '0,0%') // zero medido e um dado, nao "sem dado"
  assert.equal(pct(70), '70,0%')
  assert.equal(pct(38.4), '38,4%')
})

test('money / money2: null/undefined viram "—" (nunca "R$ 0")', () => {
  assert.equal(money(null), DASH)
  assert.equal(money(undefined), DASH)
  assert.equal(money2(null), DASH)
  assert.notEqual(money(null), 'R$ 0')
  // valor real formata em BRL (nao "—")
  assert.notEqual(money(1234), DASH)
  assert.match(money(1234), /R\$/)
})

test('datas e tempo relativo: ausencia vira "—"/"nunca", nao data zero', () => {
  assert.equal(fmtDate(null), DASH)
  assert.equal(fmtDateTime(null), DASH)
  assert.equal(fmtRelative(null), 'nunca')
  assert.equal(fmtDate('2026-12-30'), '30/12/26')
})
