import './helpers/env.js'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mockQuery, restoreQuery } from './helpers/db.js'
import { channelCompliance, findingsToCsv } from '../src/services/reports.js'

afterEach(() => restoreQuery())

test('channelCompliance: sem comparacoes -> complianceRate NULL (nao 0%)', async () => {
  // O bug era `complianceRate ?? 0`, que fazia "sem dados" parecer 0% de
  // conformidade. Sem nenhuma comparacao a taxa tem que ser null.
  mockQuery(() => ({
    rows: [
      { slug: 'trip', name: 'Trip.com', color: '#e11', comparisons: 10, violations: 3, avg_delta: -20, worst_delta: -37 },
      { slug: 'maxmilhas', name: 'MaxMilhas', color: '#09f', comparisons: 0, violations: 0, avg_delta: null, worst_delta: null }
    ]
  }))
  const out = await channelCompliance({ days: 30 })
  const trip = out.find((r) => r.slug === 'trip')
  const max = out.find((r) => r.slug === 'maxmilhas')

  assert.equal(trip.complianceRate, 70) // (10-3)/10
  assert.strictEqual(max.complianceRate, null, 'sem dados nao pode virar 0%')
  assert.notEqual(max.complianceRate, 0)
})

test('findingsToCsv: BOM, cabecalho, CRLF, escape de separador e datas', () => {
  const csv = findingsToCsv([
    {
      created_at: '2026-09-11T09:00:00Z', property_name: 'Enotel', channel_name: 'Trip.com',
      kind: 'undercut', check_in: new Date('2026-12-30T12:00:00Z'), check_out: new Date('2027-01-02T12:00:00Z'),
      los: 3, base_price: 1000, channel_price: 630, delta_abs: -370, delta_pct: -37,
      severity: 'critical', status: 'open'
    },
    {
      created_at: '2026-09-11T09:00:00Z', property_name: 'Enotel', channel_name: 'Agencia; Duvidosa',
      kind: 'undercut', check_in: '2026-10-01', check_out: '2026-10-03',
      los: 2, base_price: 500, channel_price: 450, delta_abs: -50, delta_pct: -10,
      severity: 'critical', status: 'open'
    }
  ])

  assert.equal(csv.charCodeAt(0), 0xFEFF, 'comeca com BOM para o Excel pt-BR')
  const lines = csv.slice(1).split('\r\n')
  assert.match(lines[0], /^data_deteccao;propriedade;canal;tipo;check_in;check_out;noites/)
  assert.match(lines[1], /2026-12-30;2027-01-02/) // Date -> ISO curto
  assert.match(lines[2], /"Agencia; Duvidosa"/) // campo com ; vem entre aspas
})
