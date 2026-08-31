import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { config, validateConfig } from './config.js'
import { migrate } from './db/migrate.js'
import { pool } from './db/pool.js'
import { router } from './routes/index.js'
import { startScheduler, stopScheduler } from './jobs/scheduler.js'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '1mb' }))

// Health check do EasyPanel: responde antes de qualquer autenticacao.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) })
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message })
  }
})

app.use('/api', router)
app.use(express.static(publicDir, { maxAge: config.env === 'production' ? '1h' : 0 }))

// SPA: qualquer rota nao-API cai no index.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(join(publicDir, 'index.html'))
})

app.use((req, res) => res.status(404).json({ error: 'Rota nao encontrada' }))

app.use((err, req, res, _next) => {
  const status = err.status || 500
  if (status >= 500) console.error('[api]', err)
  res.status(status).json({ error: err.message || 'Erro interno' })
})

async function boot () {
  const { fatal, warn } = validateConfig()
  for (const w of warn) console.warn(`[config] aviso: ${w}`)
  if (fatal.length > 0) {
    for (const f of fatal) console.error(`[config] ERRO: ${f}`)
    process.exit(1)
  }

  // Retenta a migracao: no primeiro deploy o Postgres do EasyPanel costuma
  // subir alguns segundos depois do app.
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await migrate()
      break
    } catch (err) {
      if (attempt === 10) {
        console.error('[boot] nao foi possivel preparar o banco:', err.message)
        process.exit(1)
      }
      console.warn(`[boot] banco indisponivel (tentativa ${attempt}/10): ${err.message}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  startScheduler()

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] Enotel Paridade rodando na porta ${config.port} (${config.env})`)
  })

  const shutdown = (signal) => {
    console.log(`[boot] ${signal} recebido, encerrando`)
    stopScheduler()
    server.close(() => pool.end().finally(() => process.exit(0)))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

boot()
