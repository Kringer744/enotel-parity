import './helpers/env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  genToken, hashToken, hashPassword, verifyPassword,
  scopeTenant, requireRole, requireTenantContext
} from '../src/lib/auth.js'

// Mock minimo de req/res/next para exercitar os middlewares como funcoes puras.
const mkRes = () => ({
  code: 200,
  body: null,
  status (c) { this.code = c; return this },
  json (o) { this.body = o; return this }
})
const mkReq = ({ user = {}, headers = {} } = {}) => ({
  user,
  get (h) { return headers[h.toLowerCase()] }
})
const run = (mw, req) => {
  const res = mkRes()
  let nexted = false
  mw(req, res, () => { nexted = true })
  return { res, nexted }
}

// ─── Credencial / convite ────────────────────────────────────────────────────
test('genToken: 64 hex e unico a cada chamada', () => {
  const a = genToken()
  const b = genToken()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
})

test('hashToken: SHA-256 deterministico, 64 hex, colide so com a mesma entrada', () => {
  const raw = genToken()
  assert.match(hashToken(raw), /^[0-9a-f]{64}$/)
  assert.equal(hashToken(raw), hashToken(raw))
  assert.notEqual(hashToken(raw), hashToken(genToken()))
})

test('hashPassword/verifyPassword: roundtrip e senha errada', async () => {
  const hash = await hashPassword('senha-super-secreta')
  assert.notEqual(hash, 'senha-super-secreta')
  assert.equal(await verifyPassword('senha-super-secreta', hash), true)
  assert.equal(await verifyPassword('errada', hash), false)
  // Entrada invalida nao lanca, so nega.
  assert.equal(await verifyPassword(undefined, undefined), false)
})

// ─── scopeTenant: a base do isolamento ───────────────────────────────────────
test('scopeTenant: tenant_admin/viewer herdam o tenant do CLAIM (imutavel)', () => {
  for (const role of ['tenant_admin', 'viewer']) {
    // Header forjado deve ser IGNORADO para usuario de tenant.
    const req = mkReq({ user: { role, tenant_id: 7 }, headers: { 'x-tenant-id': '99' } })
    const { res, nexted } = run(scopeTenant, req)
    assert.equal(nexted, true, `${role} passa`)
    assert.equal(req.tenantId, 7, `${role} usa o claim, nao o header`)
    assert.equal(res.code, 200)
  }
})

test('scopeTenant: usuario de tenant sem tenant_id -> 403', () => {
  const req = mkReq({ user: { role: 'viewer', tenant_id: null } })
  const { res, nexted } = run(scopeTenant, req)
  assert.equal(nexted, false)
  assert.equal(res.code, 403)
})

test('scopeTenant: superadmin sem header = contexto de plataforma (tenantId null)', () => {
  const req = mkReq({ user: { role: 'superadmin', tenant_id: null } })
  const { res, nexted } = run(scopeTenant, req)
  assert.equal(nexted, true)
  assert.equal(req.tenantId, null)
  assert.equal(res.code, 200)
})

test('scopeTenant: superadmin com X-Tenant-Id valido mira o tenant', () => {
  const req = mkReq({ user: { role: 'superadmin', tenant_id: null }, headers: { 'x-tenant-id': '42' } })
  const { nexted } = run(scopeTenant, req)
  assert.equal(nexted, true)
  assert.equal(req.tenantId, 42)
})

test('scopeTenant: X-Tenant-Id nao-numerico e REJEITADO (Bastiao #5: parseInt de 5abc daria 5)', () => {
  const req = mkReq({ user: { role: 'superadmin', tenant_id: null }, headers: { 'x-tenant-id': '5abc' } })
  const { res, nexted } = run(scopeTenant, req)
  assert.equal(nexted, false)
  assert.equal(res.code, 400)
  assert.equal(req.tenantId, undefined)
})

// ─── requireRole ─────────────────────────────────────────────────────────────
test('requireRole: superadmin satisfaz qualquer exigencia', () => {
  const req = mkReq({ user: { role: 'superadmin' } })
  assert.equal(run(requireRole('tenant_admin'), req).nexted, true)
})

test('requireRole: tenant_admin passa em tenant_admin, barra em superadmin', () => {
  const req = mkReq({ user: { role: 'tenant_admin' } })
  assert.equal(run(requireRole('tenant_admin'), req).nexted, true)
  assert.equal(run(requireRole('superadmin'), req).res.code, 403)
})

test('requireRole: viewer nao escreve (barrado em tenant_admin)', () => {
  const req = mkReq({ user: { role: 'viewer' } })
  const { res, nexted } = run(requireRole('tenant_admin'), req)
  assert.equal(nexted, false)
  assert.equal(res.code, 403)
})

// ─── requireTenantContext ────────────────────────────────────────────────────
test('requireTenantContext: exige tenant resolvido (400 se ausente)', () => {
  const ok = mkReq()
  ok.tenantId = 3
  assert.equal(run(requireTenantContext, ok).nexted, true)

  const bad = mkReq()
  bad.tenantId = null
  const { res, nexted } = run(requireTenantContext, bad)
  assert.equal(nexted, false)
  assert.equal(res.code, 400)
})
