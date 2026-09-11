import './helpers/env.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { pgProbe, pgEnd, resolveTable } from './helpers/pg.js'

// REGRESSAO DA MIGRACAO ADITIVA (RFC §9): o Enotel vira tenant #1 sem perder
// historico. Aditivo e idempotente -> ADD COLUMN tenant_id + backfill=1 + NOT
// NULL, renames properties->subjects / scan_targets->targets, vertical='hotel'.
//
// Integracao: valida o ESTADO pos-migracao num Postgres com o schema publicado
// (TEST_DATABASE_URL). Sem isso, SKIP limpo -- liga quando o Cortex publicar.

const probe = await pgProbe()
const skip = probe.ready ? false : probe.reason
const pool = probe.pool

after(async () => { await pgEnd() })

const STRICT = ['channels', 'scans', 'rates', 'findings', 'whatsapp_recipients', 'notifications', 'api_usage', 'settings']

test('#migração: tenant #1 (slug=enotel) existe', { skip }, async () => {
  const { rows } = await pool.query("SELECT id FROM tenants WHERE slug='enotel'")
  assert.equal(rows.length, 1, 'o Enotel foi migrado como tenant #1')
})

test('#migração: backfill completo — nenhuma linha de dado com tenant_id NULL', { skip }, async () => {
  const subjects = await resolveTable(pool, ['subjects', 'properties'])
  const targets = await resolveTable(pool, ['targets', 'scan_targets'])
  for (const t of [...STRICT, subjects, targets].filter(Boolean)) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE tenant_id IS NULL`)
    assert.equal(rows[0].n, 0, `${t}: backfill deixou linha com tenant_id NULL`)
  }
})

test('#migração: renames properties->subjects e scan_targets->targets aplicados', { skip }, async () => {
  const subjects = await resolveTable(pool, ['subjects', 'properties'])
  const targets = await resolveTable(pool, ['targets', 'scan_targets'])
  assert.equal(subjects, 'subjects', 'properties deve ter virado subjects (VIEW de compat conta como presente)')
  assert.equal(targets, 'targets', 'scan_targets deve ter virado targets')
})

test('#migração: subjects.vertical preenchido com "hotel"', { skip }, async () => {
  const subjects = await resolveTable(pool, ['subjects', 'properties'])
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS bad FROM ${subjects} WHERE vertical IS DISTINCT FROM 'hotel'`)
  assert.equal(rows[0].bad, 0, 'todo subject migrado do Enotel e vertical=hotel')
})

test('#migração: historico preservado e todo atribuido ao tenant #1 (sem perda/mis-atribuicao)', { skip }, async () => {
  // "Sem perder historico": se existem scans/rates/findings, TODOS sao do tenant 1.
  // (Aditivo: o backfill nao apaga nem reatribui para outro tenant.)
  const { rows: t1 } = await pool.query("SELECT id FROM tenants WHERE slug='enotel'")
  const enotelId = t1[0]?.id
  for (const t of ['scans', 'rates', 'findings']) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS wrong FROM ${t} WHERE tenant_id IS DISTINCT FROM $1`, [enotelId])
    assert.equal(rows[0].wrong, 0, `${t}: linha nao pertencente ao tenant #1 apos migracao`)
  }
})
