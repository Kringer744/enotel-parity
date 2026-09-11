import './env.js'
import { pool } from '../../src/db/pool.js'

// Substitui pool.query por um stub. Como src/db/pool.js expoe
//   export function query (text, params) { return pool.query(text, params) }
// trocar pool.query intercepta TODAS as queries do sistema sem tocar no codigo
// de producao -- e o seam que permite exercitar reports/budget/scanner sem um
// Postgres de verdade.

const originalQuery = pool.query.bind(pool)

/**
 * @param {(sql:string, params:any[]) => {rows:any[]}|Promise<{rows:any[]}>} handler
 */
export function mockQuery (handler) {
  pool.query = async (text, params) => {
    const sql = typeof text === 'string' ? text : text?.text ?? ''
    const result = await handler(sql, params ?? [])
    if (!result || !Array.isArray(result.rows)) {
      throw new Error(`mockQuery: handler nao devolveu {rows:[]} para: ${sql.slice(0, 60)}`)
    }
    return { rowCount: result.rows.length, ...result }
  }
}

export function restoreQuery () {
  pool.query = originalQuery
}
