import './env.js'
import pg from 'pg'

// Probe de prontidao para os testes de INTEGRACAO (isolamento multi-tenant e
// migracao). Eles precisam de um Postgres de VERDADE com o schema publicado.
//
// SEGURANCA: usa SO `TEST_DATABASE_URL` -- NUNCA o DATABASE_URL de producao.
// Sem essa env, ou sem o schema multi-tenant, os testes fazem SKIP limpo (o
// `npm test` continua verde). Ligam sozinhos quando o Cortex publicar o schema
// e a Forja prover um Postgres de teste (ex.: no CI).
//
// pg.types 1700 (NUMERIC) parseado como numero, igual a src/db/pool.js.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)))

const url = process.env.TEST_DATABASE_URL || null
let pool = null

/** @returns {Promise<{ready:boolean, reason?:string, pool?:import('pg').Pool}>} */
export async function pgProbe () {
  if (!url) {
    return { ready: false, reason: 'defina TEST_DATABASE_URL apontando p/ um Postgres de TESTE (nunca producao)' }
  }
  try {
    pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000, max: 4 })
    await pool.query('SELECT 1')
  } catch (err) {
    return { ready: false, reason: `sem conexao com TEST_DATABASE_URL: ${err.message}` }
  }
  const { rows } = await pool.query("SELECT to_regclass('public.tenants') AS t")
  if (!rows[0].t) {
    return { ready: false, reason: 'schema multi-tenant ausente (Cortex ainda nao publicou a tabela tenants)', pool }
  }
  return { ready: true, pool }
}

export async function pgEnd () {
  if (pool) { await pool.end(); pool = null }
}

/** Nome real de uma tabela que pode ter sido renomeada (ex.: properties->subjects). */
export async function resolveTable (p, candidates) {
  for (const name of candidates) {
    const { rows } = await p.query('SELECT to_regclass($1) AS t', [`public.${name}`])
    if (rows[0].t) return name
  }
  return null
}
