import pg from 'pg'
import { config } from '../config.js'

// A SerpAPI devolve precos como string; sem isto o pg entrega NUMERIC como texto
// e as comparacoes de paridade viram comparacao lexicografica silenciosamente.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)))

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
})

pool.on('error', (err) => {
  console.error('[db] erro em cliente ocioso:', err.message)
})

export function query (text, params) {
  return pool.query(text, params)
}

/**
 * Escopo de tenant OBRIGATORIO (RFC secao 4, Camada 1 -- escopo de aplicacao).
 * Falha ALTO se o tenant nao for um inteiro: esquecer o escopo vira erro, nao
 * vazamento silencioso entre clientes. Convencao: todo SQL de negocio filtra
 * `tenant_id = $1` e passa `scope.tenantId` como 1o parametro. A 2a barreira
 * (Postgres RLS) entra no endurecimento (§4.2), com app role nao-superuser.
 *
 *   const scope = forTenant(req.tenantId)
 *   scope.query('SELECT * FROM findings WHERE tenant_id = $1 AND status = $2',
 *               [scope.tenantId, 'open'])
 */
export function forTenant (tenantId) {
  if (!Number.isInteger(tenantId)) {
    throw new Error('escopo de tenant ausente: tenantId precisa ser um inteiro')
  }
  return {
    tenantId,
    query: (text, params = []) => query(text, params)
  }
}

/** Executa fn dentro de uma transacao, com rollback em qualquer excecao. */
export async function withTransaction (fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
