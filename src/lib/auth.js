import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { query } from '../db/pool.js'
import { config } from '../config.js'

const TOKEN_TTL = '12h'

// Hash bcrypt de formato valido usado apenas para gastar o mesmo tempo de CPU
// quando o e-mail nao existe. Nunca autentica ninguem: o retorno depende de
// `user` ter sido encontrado.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

export async function login (email, password) {
  // LEFT JOIN: superadmin tem tenant_id NULL (sem tenant), demais herdam o slug
  // do proprio tenant — denormalizado no claim p/ branding/subdominio sem query extra.
  const { rows } = await query(
    `SELECT u.*, t.slug AS tenant_slug
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1`,
    [String(email || '').toLowerCase().trim()]
  )
  const user = rows[0]
  // Compara mesmo sem usuario, contra um hash descartavel de formato valido,
  // para nao vazar quais e-mails existem pelo tempo de resposta.
  const hash = user?.password_hash || DUMMY_HASH
  const ok = await bcrypt.compare(String(password || ''), hash).catch(() => false)
  if (!user || !ok) return null

  // Conta desativada (users.active=false): checa DEPOIS da senha, entao o estado
  // da conta so e observavel por quem ja acertou a credencial — sem enumeracao.
  // Retorno generico (== login invalido), coerente com o DUMMY_HASH.
  if (user.active === false) return null

  const identity = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenant_id: user.tenant_id ?? null,
    tenant_slug: user.tenant_slug ?? null
  }
  const { id, ...claims } = identity
  const token = jwt.sign(
    { sub: id, ...claims },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL }
  )
  return { token, user: identity }
}

export function requireAuth (req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Nao autenticado' })

  try {
    req.user = jwt.verify(token, config.jwtSecret)
    next()
  } catch {
    res.status(401).json({ error: 'Sessao expirada' })
  }
}

// Resolve `req.tenantId` — a base do isolamento multi-tenant. Roda logo apos
// requireAuth. Para tenant_admin/viewer o tenant vem do claim e e IMUTAVEL
// (nunca de body/param/query). superadmin e global: pode mirar um tenant
// especifico via header dedicado, ou operar em contexto de plataforma
// (req.tenantId = null) para rotas como POST /tenants.
export function scopeTenant (req, res, next) {
  const { role, tenant_id: tenantId } = req.user || {}

  if (role === 'superadmin') {
    const raw = String(req.get('X-Tenant-Id') ?? '').trim()
    if (raw === '') {
      req.tenantId = null // contexto de plataforma
      return next()
    }
    // So-digitos: Number.parseInt('5abc') devolveria 5 e passaria (spoof). Bastiao §5.
    if (!/^\d+$/.test(raw)) {
      return res.status(400).json({ error: 'X-Tenant-Id invalido' })
    }
    req.tenantId = Number.parseInt(raw, 10)
    return next()
  }

  if (!Number.isInteger(tenantId)) {
    // Token de usuario de tenant sem tenant_id: conta orfa ou token antigo.
    return res.status(403).json({ error: 'Usuario sem tenant' })
  }
  req.tenantId = tenantId
  next()
}

// Guarda rotas de DADOS: exige um tenant resolvido. Um superadmin que nao
// mandou X-Tenant-Id cai aqui (400) em vez de varrer todos os tenants.
export function requireTenantContext (req, res, next) {
  if (!Number.isInteger(req.tenantId)) {
    return res.status(400).json({ error: 'Selecione um tenant' })
  }
  next()
}

// Guarda por papel. superadmin satisfaz qualquer exigencia (rank maior);
// senao o papel precisa estar na lista. Ex.: requireRole('tenant_admin')
// libera tenant_admin e superadmin, barra viewer.
export const requireRole = (...roles) => (req, res, next) => {
  const role = req.user?.role
  if (role === 'superadmin' || roles.includes(role)) return next()
  res.status(403).json({ error: 'Permissao insuficiente' })
}

export async function audit (actor, action, detail = null) {
  await query('INSERT INTO audit_log (actor, action, detail) VALUES ($1,$2,$3)', [
    actor, action, detail ? JSON.stringify(detail) : null
  ]).catch(() => {})
}
