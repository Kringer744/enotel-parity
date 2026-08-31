// Varredura avulsa pela linha de comando. Util para testar credenciais sem
// esperar o cron: `npm run scan`
import { migrate } from '../db/migrate.js'
import { runScan } from '../services/scanner.js'
import { pool } from '../db/pool.js'
import { getUsage } from '../lib/budget.js'

const before = await getUsage().catch(() => null)
if (before) console.log(`SerpAPI antes: ${before.used}/${before.limit}`)

await migrate()
const result = await runScan({ trigger: 'manual' })
console.log(JSON.stringify(result, null, 2))

const after = await getUsage()
console.log(`SerpAPI depois: ${after.used}/${after.limit}`)

await pool.end()
