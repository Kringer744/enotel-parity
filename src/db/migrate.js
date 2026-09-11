import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import bcrypt from 'bcryptjs'
import { pool, query } from './pool.js'
import { config } from '../config.js'

const here = dirname(fileURLToPath(import.meta.url))

// Tenant #1 = Enotel. O schema.sql ja garante a linha; aqui e a referencia usada
// pelos seeds. Multi-tenant real (varios) e config, nao reescrita.
const TENANT_ID = 1

// Canais monitorados do Enotel. 'patterns' casa (lowercase, substring) o campo
// "source" do Google Hotels. Cores da paleta categorica validada.
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
const DEFAULT_TARGETS = [
  { label: 'Curto prazo (7 dias)', horizon_days: 7, los: 2, adults: 2 },
  { label: 'Janela padrao (30 dias)', horizon_days: 30, los: 2, adults: 2 },
  { label: 'Planejamento (60 dias)', horizon_days: 60, los: 2, adults: 2 }
]

const DEFAULT_SETTINGS = {
  parity: {
    tolerance_pct: 1.0,
    tolerance_abs: 5.0,
    severity: { warning: 1.0, serious: 5.0, critical: 10.0 },
    report_overcut: false,
    overcut_min_pct: 15.0
  },
  notifications: {
    enabled: true,
    min_severity: 'warning',
    silent_when_clean: true,
    send_daily_summary: true
  }
}

// A consulta precisa trazer o hotel na LISTA do Google Hotels. "Enotel Porto de
// Galinhas" sozinho devolve zero resultados; incluir cidade e estado resolve.
const SUBJECT = {
  name: 'Enotel Porto de Galinhas',
  serpQuery: 'Enotel resort Ipojuca Pernambuco',
  serpToken: 'ChgIzcua6s28ueG-ARoLL2cvMXRtOGtzeGMQAQ',
  city: 'Ipojuca, PE',
  directUrl: 'https://www.enotel.com.br/'
}

/**
 * Conector de hotel do tenant #1. A credencial (api key) segue vindo da env
 * (config.serpapi) na F1; a migracao p/ tenant_connectors.config e o §11.4.
 * Aqui so registramos o teto/reserva e que o conector e MEDIDO (cota dura).
 */
async function seedTenantConnectors () {
  await query(
    `INSERT INTO tenant_connectors (tenant_id, connector_key, monthly_limit, reserve, metered)
     VALUES ($1, 'hotel_serpapi', $2, $3, TRUE)
     ON CONFLICT (tenant_id, connector_key) DO NOTHING`,
    [TENANT_ID, config.serpapi.monthlyLimit, config.serpapi.reserve]
  )
}

/**
 * Bancos legados (Enotel single-tenant): o admin unico tinha role 'admin' e
 * tenant_id nulo. Converte para o vocabulario novo ANTES do CHECK de role.
 * superadmin (se existir) mantem tenant_id NULL.
 */
async function migrateLegacyUsers () {
  await query("UPDATE users SET role = 'tenant_admin' WHERE role = 'admin'")
  await query(
    'UPDATE users SET tenant_id = $1 WHERE tenant_id IS NULL AND role <> $2',
    [TENANT_ID, 'superadmin']
  )
}

/**
 * CHECK de role so DEPOIS do backfill (senao a migracao quebra num banco legado
 * com role='admin'). Guardado: idempotente entre boots.
 */
async function ensureRoleCheck () {
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check
          CHECK (role IN ('superadmin', 'tenant_admin', 'viewer'));
      END IF;
    END $$;
  `)
}

async function seedChannels () {
  for (const c of CHANNELS) {
    await query(
      `INSERT INTO channels (slug, name, kind, patterns, color, sort_order, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             kind = EXCLUDED.kind,
             patterns = EXCLUDED.patterns,
             color = EXCLUDED.color,
             sort_order = EXCLUDED.sort_order`,
      [c.slug, c.name, c.kind, c.patterns, c.color, c.sort_order, TENANT_ID]
    )
  }
}

async function seedSubject () {
  const { rows } = await query('SELECT id, serp_query FROM subjects ORDER BY id LIMIT 1')

  if (rows.length > 0) {
    // Reparo de bancos ja provisionados com a consulta que nao retornava nada
    // (trava de regressao do bug historico #1).
    if (rows[0].serp_query === 'Enotel Porto de Galinhas') {
      await query(
        'UPDATE subjects SET serp_query = $2, serp_property_token = $3 WHERE id = $1',
        [rows[0].id, SUBJECT.serpQuery, SUBJECT.serpToken]
      )
      console.log('[migrate] consulta SerpAPI do subject corrigida')
    }
    return rows[0].id
  }

  const { rows: created } = await query(
    `INSERT INTO subjects (name, vertical, serp_query, serp_property_token, city, currency, direct_url, tenant_id)
     VALUES ($1, 'hotel', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [SUBJECT.name, SUBJECT.serpQuery, SUBJECT.serpToken, SUBJECT.city, 'BRL', SUBJECT.directUrl, TENANT_ID]
  )
  const subjectId = created[0].id

  for (const t of DEFAULT_TARGETS) {
    await query(
      `INSERT INTO targets (property_id, label, mode, horizon_days, los, adults, tenant_id)
       VALUES ($1, $2, 'rolling', $3, $4, $5, $6)
       ON CONFLICT (property_id, horizon_days, los, adults) DO NOTHING`,
      [subjectId, t.label, t.horizon_days, t.los, t.adults, TENANT_ID]
    )
  }
  return subjectId
}

async function seedSettings () {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(
      `INSERT INTO settings (key, value, tenant_id) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value), TENANT_ID]
    )
  }
}

/** Admin do tenant #1 (Enotel). Fresh: nasce como tenant_admin. */
async function seedAdmin () {
  const { rows } = await query('SELECT id FROM users WHERE email = $1', [config.admin.email])
  if (rows.length > 0) return
  const hash = await bcrypt.hash(config.admin.password, 10)
  await query(
    'INSERT INTO users (email, password_hash, name, role, tenant_id) VALUES ($1, $2, $3, $4, $5)',
    [config.admin.email, hash, config.admin.name, 'tenant_admin', TENANT_ID]
  )
  console.log(`[migrate] administrador do tenant #1 criado: ${config.admin.email}`)
}

/**
 * Superadmin da Fluxo (plataforma, tenant_id NULL). So e criado se as credenciais
 * vierem por env (SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD) -- segredo fora do repo.
 * Sem elas, apenas avisa: o superadmin pode ser criado depois.
 */
async function seedSuperadmin () {
  const email = (process.env.SUPERADMIN_EMAIL || '').toLowerCase().trim()
  const password = process.env.SUPERADMIN_PASSWORD || ''
  if (!email || !password) {
    console.warn('[migrate] SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD nao definidos - superadmin nao criado')
    return
  }
  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email])
  if (rows.length > 0) return
  const hash = await bcrypt.hash(password, 10)
  await query(
    'INSERT INTO users (email, password_hash, name, role, tenant_id) VALUES ($1, $2, $3, $4, NULL)',
    [email, hash, process.env.SUPERADMIN_NAME || 'Superadmin Fluxo', 'superadmin']
  )
  console.log(`[migrate] superadmin da plataforma criado: ${email}`)
}

export async function migrate () {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8')
  await query(sql)                 // estrutura + tenant #1 + tenant_id (backfill via DEFAULT)
  await seedTenantConnectors()
  await migrateLegacyUsers()       // admin -> tenant_admin, tenant_id nulo -> #1
  await seedAdmin()                // fresh: admin do tenant #1
  await seedSuperadmin()           // opcional, via env
  await ensureRoleCheck()          // CHECK de role SO depois dos roles validos
  await seedChannels()
  await seedSubject()
  await seedSettings()
  console.log('[migrate] schema e dados iniciais aplicados (multi-tenant, tenant #1 = Enotel)')
}

// Permite `npm run migrate` isoladamente, alem do boot do servidor.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] falhou:', err)
      process.exit(1)
    })
}
