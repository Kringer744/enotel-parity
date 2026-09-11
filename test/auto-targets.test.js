import './helpers/env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAutoPeriods, recifeToday } from '../src/jobs/autoTargets.js'

const dayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay() // 0=dom ... 5=sex
const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000)

test('computeAutoPeriods: invariantes em 60 datas de referencia consecutivas', () => {
  for (let i = 0; i < 60; i++) {
    const today = new Date(Date.UTC(2026, 8, 1 + i, 12)) // set/out 2026
    const todayIso = today.toISOString().slice(0, 10)
    const [weekend, midweek] = computeAutoPeriods(today)

    // Fim de semana = sexta -> domingo, 2 noites
    assert.equal(dayOf(weekend.checkIn), 5, `${todayIso}: fim de semana comeca na sexta`)
    assert.equal(dayOf(weekend.checkOut), 0, `${todayIso}: fim de semana termina no domingo`)
    assert.equal(daysBetween(weekend.checkIn, weekend.checkOut), 2)

    // Meio de semana = terca -> quinta, 2 noites
    assert.equal(dayOf(midweek.checkIn), 2, `${todayIso}: meio de semana comeca na terca`)
    assert.equal(dayOf(midweek.checkOut), 4, `${todayIso}: meio de semana termina na quinta`)
    assert.equal(daysBetween(midweek.checkIn, midweek.checkOut), 2)

    // Nunca gera data no passado (check-in estritamente futuro)
    assert.ok(weekend.checkIn > todayIso, `${todayIso}: fim de semana no futuro`)
    assert.ok(midweek.checkIn > todayIso, `${todayIso}: meio de semana no futuro`)

    // Os dois blocos NUNCA se sobrepoem: o meio de semana comeca depois do
    // fim de semana terminar.
    assert.ok(
      midweek.checkIn > weekend.checkOut,
      `${todayIso}: meio de semana (${midweek.checkIn}) depois do fim de semana (${weekend.checkOut})`
    )
  }
})

test('computeAutoPeriods: rotulos sem jargao e sem emoji', () => {
  const [weekend, midweek] = computeAutoPeriods(new Date(Date.UTC(2026, 8, 11, 12)))
  assert.match(weekend.label, /Fim de semana/)
  assert.match(midweek.label, /Meio de semana/)
  assert.equal(weekend.key, 'weekend')
  assert.equal(midweek.key, 'midweek')
})

test('recifeToday: aplica o desvio fixo de UTC-3 (sem horario de verao)', () => {
  const now = new Date('2026-09-11T02:00:00Z')
  const recife = recifeToday(now)
  assert.equal(now.getTime() - recife.getTime(), 3 * 3600 * 1000)
})
