import 'dotenv/config'

function bool (v, fallback = false) {
  if (v === undefined || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())
}

function int (v, fallback) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  port: int(process.env.PORT, 3000),
  env: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-inseguro-troque-em-producao',

  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@enotel.com.br',
    password: process.env.ADMIN_PASSWORD || 'enotel2026',
    name: process.env.ADMIN_NAME || 'Administrador'
  },

  db: {
    url: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
  },

  serpapi: {
    key: process.env.SERPAPI_KEY || '',
    monthlyLimit: int(process.env.SERPAPI_MONTHLY_LIMIT, 250),
    reserve: int(process.env.SERPAPI_RESERVE, 25),
    endpoint: 'https://serpapi.com/search.json'
  },

  uazapi: {
    url: (process.env.UAZAPI_URL || '').replace(/\/+$/, ''),
    adminToken: process.env.UAZAPI_ADMIN_TOKEN || '',
    instanceToken: process.env.UAZAPI_INSTANCE_TOKEN || ''
  },

  scan: {
    cron: process.env.SCAN_CRON || '10 6 * * *',
    timezone: process.env.SCAN_TIMEZONE || 'America/Recife',
    schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true)
  }
}

/** Falhas de configuracao que impedem o boot, separadas das que so degradam. */
export function validateConfig () {
  const fatal = []
  const warn = []

  if (!config.db.url) fatal.push('DATABASE_URL nao definida')
  if (config.env === 'production' && config.jwtSecret.startsWith('dev-secret')) {
    fatal.push('JWT_SECRET precisa ser definida em producao')
  }
  if (!config.serpapi.key) warn.push('SERPAPI_KEY vazia - varreduras ficarao indisponiveis')
  if (!config.uazapi.url) warn.push('UAZAPI_URL vazia - alertas de WhatsApp ficarao indisponiveis')

  return { fatal, warn }
}
