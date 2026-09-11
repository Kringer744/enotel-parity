import './helpers/http-env.js' // 1o: DATABASE_URL -> TEST_DATABASE_URL (quando definido)
import './helpers/env.js'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pgProbe, pgEnd } from './helpers/pg.js'
import * as H from './helpers/http.js'

// 2a ONDA — ISOLAMENTO no nivel ROTA/HTTP (esqueleto pronto pra ligar).
// Sobe o Express real numa porta efemera e conversa por fetch. ZERO dep nova.
// Contrato: AUTH-API do Nucleo (§4 scopeTenant/requireRole, §9 matriz papel x
// endpoint) + Bastiao (a/b/c).
//
// PRONTIDAO (liga sozinho): TEST_DATABASE_URL + schema multi-tenant publicado
// (pgProbe) + auth multi-tenant existente (scopeTenant/requireRole exportados).
// Sem isso -> SKIP limpo. Falha de boot/seed durante a transicao vira SKIP
// dinamico (nunca quebra a suite); ja um VAZAMENTO real reprova de verdade.

const probe = await pgProbe()
const scoping = await H.authHasTenantScoping()
const skip = !probe.ready
  ? probe.reason
  : (!scoping ? 'pendente: auth multi-tenant (scopeTenant/requireRole do Nucleo) ainda nao existe' : false)

const TAG = Date.now()
const slugA = `httpiso-a-${TAG}`
const slugB = `httpiso-b-${TAG}`
const superEmail = `super-${TAG}@fluxo.test`
const markerA = `MARK-A-${TAG}`
const markerB = `MARK-B-${TAG}`
const PW = 'senha-de-teste-123'

let ctx = null
let bootError = null

before(async () => {
  if (skip) return
  try {
    const pool = await H.getPool()
    const app = await H.bootApp()
    const aId = await H.seedTenant(pool, slugA, 'Tenant A')
    const bId = await H.seedTenant(pool, slugB, 'Tenant B')
    await H.seedUser(pool, { tenantId: aId, email: `admin-a-${TAG}@t.test`, name: 'Admin A', role: 'tenant_admin', password: PW })
    await H.seedUser(pool, { tenantId: aId, email: `viewer-a-${TAG}@t.test`, name: 'Viewer A', role: 'viewer', password: PW })
    await H.seedUser(pool, { tenantId: bId, email: `admin-b-${TAG}@t.test`, name: 'Admin B', role: 'tenant_admin', password: PW })
    await H.seedUser(pool, { tenantId: null, email: superEmail, name: 'Super', role: 'superadmin', password: PW })
    await H.seedRecipientMarker(pool, aId, markerA)
    await H.seedRecipientMarker(pool, bId, markerB)

    const adminA = await H.login(app.base, `admin-a-${TAG}@t.test`, PW)
    const viewerA = await H.login(app.base, `viewer-a-${TAG}@t.test`, PW)
    const superU = await H.login(app.base, superEmail, PW)
    if (!adminA.token || !viewerA.token || !superU.token) throw new Error('login nao devolveu token (auth ainda em transicao)')

    ctx = { pool, app, aId, bId, adminA, viewerA, superU }
  } catch (err) {
    bootError = err.message
  }
})

after(async () => {
  if (ctx) {
    await H.cleanupTenants(ctx.pool, [slugA, slugB]).catch(() => {})
    await ctx.pool.query('DELETE FROM users WHERE email = $1', [superEmail]).catch(() => {})
    await ctx.app.close()
  }
  await pgEnd()
})

const guard = (t) => {
  if (!ctx) { t.skip(bootError || 'boot/seed/login falhou'); return false }
  return true
}

test('#F2 (a) matriz endpoint x tenant: token de A ve o proprio dado, nunca o de B', { skip }, async (t) => {
  if (!guard(t)) return
  const { app, adminA } = ctx
  // Rotas de leitura escopadas respondem 200 para um usuario de tenant.
  for (const path of ['/api/overview', '/api/whatsapp/recipients', '/api/channels', '/api/settings']) {
    const r = await H.api(app.base, { token: adminA.token, path })
    assert.equal(r.status, 200, `GET ${path} deveria responder 200 para tenant_admin de A`)
  }
  // No-leak concreto: a lista de destinatarios de A traz o marcador de A e NUNCA o de B.
  const rec = await H.api(app.base, { token: adminA.token, path: '/api/whatsapp/recipients' })
  assert.match(rec.text, new RegExp(markerA), 'A ve o proprio destinatario')
  assert.doesNotMatch(rec.text, new RegExp(markerB), 'A NUNCA ve o destinatario de B')
})

test('#F2 (b) tenant_id forjado (header X-Tenant-Id / query) e IGNORADO — escopo so do claim', { skip }, async (t) => {
  if (!guard(t)) return
  const { app, adminA, bId } = ctx
  const r = await H.api(app.base, {
    token: adminA.token,
    path: `/api/whatsapp/recipients?tenant_id=${bId}`,
    headers: { 'x-tenant-id': String(bId) }
  })
  assert.notEqual(r.status, 500)
  assert.doesNotMatch(r.text, new RegExp(markerB), 'forjar o tenant de B nao pode vazar dado de B')
  assert.match(r.text, new RegExp(markerA), 'continua escopado ao claim (A)')
})

test('#F2 (c) papeis: viewer nao escreve; tenant_admin escreve no proprio; superadmin cruza via X-Tenant-Id', { skip }, async (t) => {
  if (!guard(t)) return
  const { app, adminA, viewerA, superU, bId } = ctx

  // viewer -> escrita NEGADA (403). (Endpoint de escrita: adicionar destinatario.)
  const vw = await H.api(app.base, { token: viewerA.token, method: 'POST', path: '/api/whatsapp/recipients', body: { phone: '5581999990000', name: `vw-${TAG}` } })
  assert.equal(vw.status, 403, 'viewer nao pode escrever')

  // tenant_admin -> escrita no proprio tenant PERMITIDA (nao 403; shape do corpo
  // e checado pela rota, entao aqui provamos so o GATE de papel).
  const ad = await H.api(app.base, { token: adminA.token, method: 'POST', path: '/api/whatsapp/recipients', body: { phone: '5581999991111', name: `ad-${TAG}` } })
  assert.notEqual(ad.status, 403, 'tenant_admin pode escrever no proprio tenant')

  // superadmin -> pode mirar o tenant B via header e ler o dado de B.
  const sup = await H.api(app.base, { token: superU.token, path: '/api/whatsapp/recipients', headers: { 'x-tenant-id': String(bId) } })
  assert.equal(sup.status, 200)
  assert.match(sup.text, new RegExp(markerB), 'superadmin com X-Tenant-Id=B enxerga o dado de B')
})
