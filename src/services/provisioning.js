import { pool, withTransaction } from '../db/pool.js'
import { getVertical, defaultChannelsFor, defaultTargetsFor } from '../verticals/index.js'
import { genToken, hashToken, hashPassword } from '../lib/auth.js'
import { config } from '../config.js'

// Provisionamento de tenant -- FONTE UNICA usada pela rota superadmin POST /tenants
// e pela CLI add-tenant (runbook do Forja). Transacional e ALL-EXPLICIT: todo
// INSERT passa tenant_id (nao depende do DEFAULT 1), entao criar o tenant #2 nunca
// cai no tenant #1 por engano -- endereca a preocupacao do Bastiao por construcao.

const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/     // 3-32, subdomain-safe
// Slug vira subdominio: nomes de servico nao podem ser sequestrados (Bastiao §6).
const RESERVED_SLUGS = new Set(['api', 'www', 'admin', 'public', 'app', 'auth', 'static', 'assets', 'cdn', 'mail'])
const HEX_RX = /^#[0-9a-f]{6}$/i
const MIN_PASSWORD = 10

export class ProvisionError extends Error {
  constructor (message, { status = 400 } = {}) {
    super(message)
    this.name = 'ProvisionError'
    this.status = status
  }
}

const normEmail = (v) => String(v || '').toLowerCase().trim()

// Tabelas-canario do gate de cutover (Bastiao 1c / Nucleo A). Enquanto tenant_id
// tiver DEFAULT nelas, a plataforma NAO passou pelo cutover multi-tenant e criar
// um 2o tenant e inseguro (um INSERT que esquecesse o tenant_id cairia no #1).
// provisionTenant e all-explicit, mas o guard e fail-closed por defesa: recusa
// provisionar ate o cutover (npm run cutover), que so roda apos a matriz de
// isolamento HTTP da Sentinela ficar verde. Guard tanto na rota (Nucleo) quanto
// na CLI, porque ambas caem aqui.
const CANARY_TABLES = ['findings', 'rates', 'targets', 'scans', 'channels', 'subjects', 'notifications']

async function assertCutoverDone (client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'
       AND table_name = ANY($1) AND column_default IS NOT NULL`,
    [CANARY_TABLES]
  )
  if (rows[0].n > 0) {
    throw new ProvisionError(
      'Cutover multi-tenant pendente: rode "npm run cutover" (apos a matriz de isolamento verde) ' +
      'antes de provisionar um novo tenant.',
      { status: 409 }
    )
  }
}

// Branding e superficie de stored-XSS (Bastiao §2): so chaves conhecidas,
// logo_url https, cores hex. O front aplica como valor CSS / atributo src, nunca innerHTML.
function sanitizeBranding (input) {
  if (input == null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ProvisionError('Branding invalido')
  }
  const out = {}
  if (input.logo_url != null && input.logo_url !== '') {
    const url = String(input.logo_url).trim()
    if (!/^https:\/\//i.test(url)) throw new ProvisionError('logo_url precisa ser uma URL https')
    out.logo_url = url
  }
  for (const key of ['primary_color', 'accent_color', 'sidebar_color']) {
    if (input[key] != null && input[key] !== '') {
      if (!HEX_RX.test(String(input[key]))) throw new ProvisionError(`${key} precisa ser cor hex (#RRGGBB)`)
      out[key] = String(input[key]).toLowerCase()
    }
  }
  if (input.company_name != null) out.company_name = String(input.company_name).slice(0, 80)
  return out
}

/**
 * Provisiona um tenant novo por completo:
 *   tenant + tenant_connectors + canais padrao (+ subject inicial + alvos, se dado)
 *   + admin (usuario com senha, ou convite de uso unico).
 *
 * @param {object} input
 * @param {string} input.slug            subdomain-safe, unico
 * @param {string} input.name            nome de exibicao do tenant
 * @param {string} [input.vertical]      'hotel' (default) | vertical ativo
 * @param {object} [input.branding]      { logo_url, primary_color, ... }
 * @param {object} input.admin           { email, name, password? } -- sem password gera convite
 * @param {object} [input.subject]       { name, serpQuery, city, directUrl } -- opcional
 * @returns {Promise<object>} resumo do provisionamento
 */
export async function provisionTenant (input = {}) {
  const { vertical = 'hotel', admin = {}, subject = null } = input
  const slug = String(input.slug || '').toLowerCase().trim()
  const name = String(input.name || '').trim()

  const v = getVertical(vertical)
  if (!v) throw new ProvisionError(`Vertical desconhecido: ${vertical}`)
  if (!v.active) throw new ProvisionError(`Vertical "${vertical}" ainda nao esta habilitado`)
  if (!SLUG_RX.test(slug)) throw new ProvisionError('slug invalido (3-32 chars, a-z 0-9 -, subdomain-safe)')
  if (RESERVED_SLUGS.has(slug)) throw new ProvisionError('slug reservado')
  if (name.length < 2 || name.length > 80) throw new ProvisionError('nome do tenant precisa ter 2 a 80 chars')

  const adminEmail = normEmail(admin.email)
  if (!adminEmail) throw new ProvisionError('informe o e-mail do admin do tenant')
  if (admin.password != null && String(admin.password).length < MIN_PASSWORD) {
    throw new ProvisionError(`senha do admin precisa ter ao menos ${MIN_PASSWORD} caracteres`)
  }
  const branding = sanitizeBranding(input.branding)

  return withTransaction(async (client) => {
    // Gate de cutover (fail-closed): sem cutover, nao provisiona 2o tenant.
    await assertCutoverDone(client)

    const dup = await client.query('SELECT 1 FROM tenants WHERE slug = $1', [slug])
    if (dup.rowCount) throw new ProvisionError(`slug "${slug}" ja esta em uso`, { status: 409 })

    // E-mail e UNIQUE global na F1: 1 e-mail = 1 conta = 1 tenant.
    const emailDup = await client.query('SELECT 1 FROM users WHERE email = $1', [adminEmail])
    if (emailDup.rowCount) throw new ProvisionError('ja existe uma conta com este e-mail', { status: 409 })

    // 1) tenant
    const { rows: tRows } = await client.query(
      `INSERT INTO tenants (slug, name, branding)
       VALUES ($1, $2, $3)
       RETURNING id, slug, name, branding, active, created_at`,
      [slug, name, JSON.stringify(branding)]
    )
    const tenant = tRows[0]
    const tenantId = tenant.id

    // 2) conector do vertical (limite/reserva do plano; metered=true p/ SerpAPI)
    await client.query(
      `INSERT INTO tenant_connectors (tenant_id, connector_key, monthly_limit, reserve, metered)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [tenantId, v.connectorKey, config.serpapi.monthlyLimit, config.serpapi.reserve]
    )

    // 3) canais padrao do vertical (direct da marca + concorrentes), all-explicit
    const brandPatterns = [slug, ...name.toLowerCase().split(/\s+/).filter((w) => w.length > 2)]
    const channels = defaultChannelsFor(vertical, { brandName: name, brandPatterns })
    for (const c of channels) {
      await client.query(
        `INSERT INTO channels (slug, name, kind, patterns, color, sort_order, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [c.slug, c.name, c.kind, c.patterns, c.color, c.sort_order, tenantId]
      )
    }

    // 4) subject inicial + alvos padrao (opcional)
    let subjectId = null
    if (subject && subject.name) {
      const { rows: sRows } = await client.query(
        `INSERT INTO subjects (name, vertical, serp_query, city, currency, direct_url, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [String(subject.name).trim(), vertical, subject.serpQuery || null,
          subject.city || null, subject.currency || 'BRL', subject.directUrl || null, tenantId]
      )
      subjectId = sRows[0].id
      for (const t of defaultTargetsFor(vertical)) {
        await client.query(
          `INSERT INTO targets (property_id, label, mode, horizon_days, los, adults, tenant_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (property_id, horizon_days, los, adults) DO NOTHING`,
          [subjectId, t.label, t.mode, t.horizon_days, t.los, t.adults, tenantId]
        )
      }
    }

    // 5) admin: senha direta (login imediato) OU convite de uso unico
    let adminResult
    if (admin.password) {
      const hash = await hashPassword(admin.password)
      const { rows: uRows } = await client.query(
        `INSERT INTO users (email, password_hash, name, role, tenant_id, active)
         VALUES ($1, $2, $3, 'tenant_admin', $4, TRUE) RETURNING id`,
        [adminEmail, hash, admin.name || name, tenantId]
      )
      adminResult = { userId: uRows[0].id, email: adminEmail, mode: 'password' }
    } else {
      const raw = genToken()
      await client.query(
        `INSERT INTO invites (tenant_id, email, name, role, token_hash, purpose, expires_at)
         VALUES ($1, $2, $3, 'tenant_admin', $4, 'invite', now() + interval '72 hours')`,
        [tenantId, adminEmail, admin.name || null, hashToken(raw)]
      )
      adminResult = { email: adminEmail, mode: 'invite', invitePath: `/convite/${raw}` }
    }

    return {
      tenant,
      vertical,
      channels: channels.length,
      subjectId,
      admin: adminResult
    }
  })
}

// Fecha o pool quando usado como script standalone (CLI). Nao chamar no servidor.
export async function closePool () {
  await pool.end()
}
