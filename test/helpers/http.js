import './http-env.js' // 1o: DATABASE_URL -> TEST_DATABASE_URL (quando definido)
import './env.js'
import express from 'express'
import bcrypt from 'bcryptjs'

// Infra do teste de rota/HTTP: sobe o Express real (router de producao) numa
// porta efemera e conversa por fetch nativo. ZERO dependencia nova -- express e
// bcryptjs ja sao do projeto; fetch e nativo (Node 24). Seeds/limpeza usam o
// mesmo pool que o app (apontado pro TEST_DATABASE_URL por http-env.js).

/** Sobe o app real numa porta efemera. Retorna { base, close }. */
export async function bootApp () {
  const { router } = await import('../../src/routes/index.js')
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r))
  }
}

/** True quando a auth multi-tenant do Nucleo ja existe (gatilho de prontidao). */
export async function authHasTenantScoping () {
  try {
    const m = await import('../../src/lib/auth.js')
    return typeof m.scopeTenant === 'function' && typeof m.requireRole === 'function'
  } catch {
    return false
  }
}

export async function login (base, email, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, token: body?.token || null, user: body?.user || null }
}

/** Requisicao autenticada. `headers` extra permite forjar X-Tenant-Id no teste (b). */
export async function api (base, { token, method = 'GET', path, body, headers = {} }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* nao-JSON */ }
  return { status: res.status, json, text }
}

// ─── Seeds / limpeza (usam o pool do app) ────────────────────────────────────

export async function getPool () {
  const { pool } = await import('../../src/db/pool.js')
  return pool
}

export async function seedTenant (pool, slug, name) {
  const { rows } = await pool.query('INSERT INTO tenants (slug,name) VALUES ($1,$2) RETURNING id', [slug, name])
  return rows[0].id
}

export async function seedUser (pool, { tenantId, email, name, role, password }) {
  const hash = bcrypt.hashSync(password, 8)
  await pool.query(
    'INSERT INTO users (tenant_id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,$5)',
    [tenantId, email, name, role, hash]
  )
}

/** Marcador detectavel: um destinatario de WhatsApp por tenant (tabela simples e escopada). */
export async function seedRecipientMarker (pool, tenantId, marker) {
  await pool.query(
    'INSERT INTO whatsapp_recipients (tenant_id,phone,name) VALUES ($1,$2,$3)',
    [tenantId, `55${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 13), marker]
  )
}

/** Marcador em `channels` (list endpoint GET /channels) — outra superficie de read-leak. */
export async function seedChannelMarker (pool, tenantId, marker) {
  await pool.query(
    "INSERT INTO channels (tenant_id, slug, name, kind) VALUES ($1,$2,$3,'ota')",
    [tenantId, marker.toLowerCase(), marker]
  )
}

/** Marcador em `notifications` (GET /whatsapp/notifications) — o corpo carrega os achados do tenant. */
export async function seedNotificationMarker (pool, tenantId, body) {
  await pool.query(
    'INSERT INTO notifications (tenant_id, phone, body) VALUES ($1,$2,$3)',
    [tenantId, `55${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 13), body]
  )
}

/** ON DELETE CASCADE em tenants limpa todos os filhos seedados. */
export async function cleanupTenants (pool, slugs) {
  await pool.query('DELETE FROM tenants WHERE slug = ANY($1)', [slugs])
}
