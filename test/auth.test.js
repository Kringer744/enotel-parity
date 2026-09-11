import './helpers/env.js'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { mockQuery, restoreQuery } from './helpers/db.js'
import { login, requireAuth, scopeTenant, requireRole, requireTenantContext } from '../src/lib/auth.js'

// Auth multi-tenant (Nucleo). Os middlewares sao funcoes puras sobre (req,res,next)
// -> testaveis SEM banco. `login` usa o pool -> seam via mockQuery. Amarra os
// QA-SEC.1/2/3/9 da checklist da Bussola.

const SECRET = process.env.JWT_SECRET

function mkRes () {
  const r = { code: undefined, body: undefined }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  return r
}
function mkReq ({ user, headers = {}, tenantId } = {}) {
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  return { user, headers, tenantId, get: (h) => lower[String(h).toLowerCase()] }
}
function nextSpy () { const f = () => { f.called = true }; f.called = false; return f }

afterEach(() => restoreQuery())

// ─── requireAuth (QA-SEC.9: sessao assinada; trocar segredo invalida) ─────────

test('requireAuth: token valido popula req.user e segue', () => {
  const token = jwt.sign({ sub: 1, role: 'viewer', tenant_id: 2 }, SECRET)
  const req = mkReq({ headers: { authorization: `Bearer ${token}` } })
  const res = mkRes(); const next = nextSpy()
  requireAuth(req, res, next)
  assert.ok(next.called)
  assert.equal(req.user.sub, 1)
  assert.equal(res.code, undefined)
})

test('requireAuth: sem token -> 401', () => {
  const res = mkRes(); const next = nextSpy()
  requireAuth(mkReq(), res, next)
  assert.equal(res.code, 401)
  assert.ok(!next.called)
})

test('#SEC.9 requireAuth: token assinado com OUTRO segredo -> 401 (trocar JWT_SECRET invalida sessoes)', () => {
  const token = jwt.sign({ sub: 1, role: 'viewer', tenant_id: 2 }, 'segredo-diferente')
  const res = mkRes(); const next = nextSpy()
  requireAuth(mkReq({ headers: { authorization: `Bearer ${token}` } }), res, next)
  assert.equal(res.code, 401)
  assert.ok(!next.called)
})

test('#SEC.9 requireAuth: token expirado -> 401', () => {
  const token = jwt.sign({ sub: 1, role: 'viewer', tenant_id: 2 }, SECRET, { expiresIn: '-1s' })
  const res = mkRes(); const next = nextSpy()
  requireAuth(mkReq({ headers: { authorization: `Bearer ${token}` } }), res, next)
  assert.equal(res.code, 401)
})

// ─── scopeTenant (QA-SEC.2: tenant do claim, imutavel; body/header ignorado) ──

test('#SEC.2 scopeTenant: tenant_admin/viewer usam o tenant do CLAIM e ignoram X-Tenant-Id forjado', () => {
  for (const role of ['tenant_admin', 'viewer']) {
    const req = mkReq({ user: { role, tenant_id: 7 }, headers: { 'X-Tenant-Id': '99' } })
    const res = mkRes(); const next = nextSpy()
    scopeTenant(req, res, next)
    assert.ok(next.called)
    assert.equal(req.tenantId, 7, `${role}: escopo vem do claim, nunca do header`)
  }
})

test('#SEC.2 scopeTenant: usuario de tenant sem tenant_id -> 403', () => {
  const res = mkRes(); const next = nextSpy()
  scopeTenant(mkReq({ user: { role: 'viewer', tenant_id: null } }), res, next)
  assert.equal(res.code, 403)
  assert.ok(!next.called)
})

test('#SEC.3 scopeTenant: superadmin sem header -> contexto de plataforma (tenantId null)', () => {
  const req = mkReq({ user: { role: 'superadmin', tenant_id: null } })
  const res = mkRes(); const next = nextSpy()
  scopeTenant(req, res, next)
  assert.ok(next.called)
  assert.equal(req.tenantId, null)
})

test('#SEC.3 scopeTenant: superadmin com X-Tenant-Id numerico mira o tenant; spoof "5abc" -> 400', () => {
  const ok = mkReq({ user: { role: 'superadmin' }, headers: { 'X-Tenant-Id': '5' } })
  const r1 = mkRes(); const n1 = nextSpy()
  scopeTenant(ok, r1, n1)
  assert.ok(n1.called); assert.equal(ok.tenantId, 5)

  const spoof = mkReq({ user: { role: 'superadmin' }, headers: { 'X-Tenant-Id': '5abc' } })
  const r2 = mkRes(); const n2 = nextSpy()
  scopeTenant(spoof, r2, n2)
  assert.equal(r2.code, 400, 'X-Tenant-Id nao-numerico e rejeitado (anti-spoof)')
  assert.ok(!n2.called)
})

// ─── requireRole (QA-SEC.1: viewer nao escreve; QA-SEC.3: superadmin cruza) ───

test('#SEC.1 requireRole("tenant_admin"): viewer -> 403; tenant_admin e superadmin passam', () => {
  const gate = requireRole('tenant_admin')

  const rv = mkRes(); const nv = nextSpy()
  gate(mkReq({ user: { role: 'viewer' } }), rv, nv)
  assert.equal(rv.code, 403, 'viewer nao escreve')
  assert.ok(!nv.called)

  const ra = mkRes(); const na = nextSpy()
  gate(mkReq({ user: { role: 'tenant_admin' } }), ra, na)
  assert.ok(na.called); assert.equal(ra.code, undefined)

  const rs = mkRes(); const ns = nextSpy()
  gate(mkReq({ user: { role: 'superadmin' } }), rs, ns)
  assert.ok(ns.called, 'superadmin satisfaz qualquer requireRole (rank maior)')
})

test('requireTenantContext: sem tenant resolvido -> 400; com tenant -> segue', () => {
  const r1 = mkRes(); const n1 = nextSpy()
  requireTenantContext(mkReq({ tenantId: null }), r1, n1)
  assert.equal(r1.code, 400)
  const r2 = mkRes(); const n2 = nextSpy()
  requireTenantContext(mkReq({ tenantId: 3 }), r2, n2)
  assert.ok(n2.called)
})

// ─── login (seam): claim de tenant + papel, e negacoes (QA-SEC.9) ─────────────

const userRow = (over = {}) => ({
  id: 42, email: 'gestor@enotel.com.br', name: 'Gestor',
  password_hash: bcrypt.hashSync('senha-correta', 8),
  role: 'tenant_admin', tenant_id: 1, tenant_slug: 'enotel', active: true, ...over
})

test('#SEC.9 login: sucesso assina claim {sub,tenant_id,tenant_slug,role}', async () => {
  mockQuery(() => ({ rows: [userRow()] }))
  const out = await login('GESTOR@enotel.com.br ', 'senha-correta')
  assert.ok(out, 'login valido devolve token+user')
  assert.equal(out.user.tenant_id, 1)
  assert.equal(out.user.tenant_slug, 'enotel')
  assert.equal(out.user.role, 'tenant_admin')
  const claims = jwt.decode(out.token)
  assert.equal(claims.sub, 42)
  assert.equal(claims.tenant_id, 1)
  assert.equal(claims.tenant_slug, 'enotel')
  assert.equal(claims.role, 'tenant_admin')
})

test('login: senha errada -> null (sem vazar existencia)', async () => {
  mockQuery(() => ({ rows: [userRow()] }))
  assert.equal(await login('gestor@enotel.com.br', 'errada'), null)
})

test('login: conta desativada -> null (mesmo com senha correta)', async () => {
  mockQuery(() => ({ rows: [userRow({ active: false })] }))
  assert.equal(await login('gestor@enotel.com.br', 'senha-correta'), null)
})

test('login: e-mail inexistente -> null (compara contra DUMMY_HASH, sem enumeracao)', async () => {
  mockQuery(() => ({ rows: [] }))
  assert.equal(await login('naoexiste@x.com', 'qualquer'), null)
})
