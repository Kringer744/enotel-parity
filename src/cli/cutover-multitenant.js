// Cutover multi-tenant (endurecimento pre-deploy). Remove o DEFAULT 1 de
// tenant_id nas tabelas de dados: dai em diante todo INSERT PRECISA passar
// tenant_id explicito -- esquecer vira erro NOT NULL (fail-closed), nunca
// mis-atribuicao ao tenant #1. Libera o guard do provisionTenant (criar 2o
// tenant).
//
// SO RODAR apos a matriz de isolamento HTTP da Sentinela ficar VERDE (Bastiao
// 1c / Nucleo A). Atomico: ou dropa em todas, ou em nenhuma. Idempotente:
// re-rodar e no-op (DROP DEFAULT sem default nao falha).
//
//   npm run cutover
import { pool, withTransaction } from '../db/pool.js'

// Tabelas cujo INSERT ja e all-explicit (scanner, migrate, provisioning,
// autoTargets, reports/settings, notifier). notifications ENTRA: carrega o corpo
// da notificacao por tenant (dado confidencial), fail-closed obrigatorio (Bastiao).
// NAO inclui api_usage (cota da chave SerpAPI compartilhada) nem whatsapp_recipients
// (UNIQUE(phone) global adiado): essas seguem com DEFAULT ate o §11.4.
const TABLES = ['findings', 'rates', 'targets', 'scans', 'channels', 'subjects', 'settings', 'notifications']

async function run () {
  // Seguranca: nenhuma linha pode estar com tenant_id NULL (backfill incompleto).
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id IS NULL`)
    if (rows[0].n > 0) {
      throw new Error(`Abortado: ${t} tem ${rows[0].n} linha(s) com tenant_id NULL - faca o backfill antes do cutover`)
    }
  }

  await withTransaction(async (client) => {
    for (const t of TABLES) {
      await client.query(`ALTER TABLE ${t} ALTER COLUMN tenant_id DROP DEFAULT`)
      console.log(`[cutover] ${t}.tenant_id DEFAULT removido`)
    }
  })

  console.log('[cutover] concluido: tenant_id agora e fail-closed nas tabelas de dados.')
  console.log('[cutover] o guard do provisionTenant esta liberado (criar 2o tenant e seguro).')
}

run()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[cutover] falhou:', err.message)
    pool.end().finally(() => process.exit(1))
  })
