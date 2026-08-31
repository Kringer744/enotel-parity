import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import bcrypt from 'bcryptjs'
import { pool, query } from './pool.js'
import { config } from '../config.js'

const here = dirname(fileURLToPath(import.meta.url))

// Canais monitorados. 'patterns' casa (lowercase, substring) o campo "source"
// devolvido pelo Google Hotels. As cores vem da paleta categorica validada.
const CHANNELS = [
  { slug: 'direct', name: 'Enotel (site oficial)', kind: 'direct', sort_order: 0, color: '#2a78d6',
    patterns: ['enotel', 'official site', 'site oficial', 'hotel website', 'book on the official'] },
  { slug: 'booking', name: 'Booking.com', kind: 'ota', sort_order: 10, color: '#eb6834',
    patterns: ['booking.com', 'booking'] },
  { slug: 'expedia', name: 'Expedia', kind: 'ota', sort_order: 20, color: '#1baf7a',
    patterns: ['expedia'] },
  { slug: 'hoteis_com', name: 'Hoteis.com', kind: 'ota', sort_order: 30, color: '#eda100',
    patterns: ['hoteis.com', 'hoteis', 'hotels.com'] },
  { slug: 'trip_com', name: 'Trip.com', kind: 'ota', sort_order: 40, color: '#e87ba4',
    patterns: ['trip.com', 'trip '] },
  { slug: 'maxmilhas', name: 'MaxMilhas (Max)', kind: 'ota', sort_order: 50, color: '#008300',
    patterns: ['maxmilhas', 'max milhas', 'maxmilhas.com'] },
  { slug: 'azul_viagens', name: 'Azul Viagens', kind: 'ota', sort_order: 60, color: '#4a3aa7',
    patterns: ['azul viagens', 'azulviagens', 'azul'] }
]

// Tres horizontes cobrem last-minute, janela de reserva e planejamento.
// 3 alvos x 30 varreduras = 90 requisicoes/mes, dentro das 250 do plano.
const DEFAULT_TARGETS = [
  { label: 'Curto prazo (7 dias)', horizon_days: 7, los: 2, adults: 2 },
  { label: 'Janela padrao (30 dias)', horizon_days: 30, los: 2, adults: 2 },
  { label: 'Planejamento (60 dias)', horizon_days: 60, los: 2, adults: 2 }
]

const DEFAULT_SETTINGS = {
  parity: {
    // Diferenca abaixo da qual nada e reportado (ruido de arredondamento/cambio)
    tolerance_pct: 1.0,
    tolerance_abs: 5.0,
    // Faixas de severidade sobre o desconto percentual da OTA frente ao direto
    severity: { warning: 1.0, serious: 5.0, critical: 10.0 },
    // Reportar tambem OTA MAIS CARA que o direto (nao e violacao, e perda de conversao)
    report_overcut: false,
    overcut_min_pct: 15.0
  },
  notifications: {
    enabled: true,
    // Nao notificar achados apenas 'info'
    min_severity: 'warning',
    // Nao dispara WhatsApp se a varredura nao achou nada
    silent_when_clean: true,
    send_daily_summary: true
  }
}

async function seedChannels () {
  for (const c of CHANNELS) {
    await query(
      `INSERT INTO channels (slug, name, kind, patterns, color, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             kind = EXCLUDED.kind,
             patterns = EXCLUDED.patterns,
             color = EXCLUDED.color,
             sort_order = EXCLUDED.sort_order`,
      [c.slug, c.name, c.kind, c.patterns, c.color, c.sort_order]
    )
  }
}

async function seedProperty () {
  const { rows } = await query('SELECT id FROM properties LIMIT 1')
  if (rows.length > 0) return rows[0].id

  const { rows: created } = await query(
    `INSERT INTO properties (name, serp_query, city, currency, direct_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      'Enotel Porto de Galinhas',
      'Enotel Porto de Galinhas',
      'Ipojuca, PE',
      'BRL',
      'https://www.enotel.com.br/'
    ]
  )
  const propertyId = created[0].id

  for (const t of DEFAULT_TARGETS) {
    await query(
      `INSERT INTO scan_targets (property_id, label, horizon_days, los, adults)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (property_id, horizon_days, los, adults) DO NOTHING`,
      [propertyId, t.label, t.horizon_days, t.los, t.adults]
    )
  }
  return propertyId
}

async function seedSettings () {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    )
  }
}

async function seedAdmin () {
  const { rows } = await query('SELECT id FROM users WHERE email = $1', [config.admin.email])
  if (rows.length > 0) return
  const hash = await bcrypt.hash(config.admin.password, 10)
  await query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)',
    [config.admin.email, hash, config.admin.name, 'admin']
  )
  console.log(`[migrate] usuario administrador criado: ${config.admin.email}`)
}

export async function migrate () {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8')
  await query(sql)
  await seedChannels()
  await seedProperty()
  await seedSettings()
  await seedAdmin()
  console.log('[migrate] schema e dados iniciais aplicados')
}

// Permite `npm run migrate` isoladamente, alem do boot do servidor.
// pathToFileURL normaliza tanto '/app/src/...' quanto 'C:\Users\...'.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] falhou:', err)
      process.exit(1)
    })
}
