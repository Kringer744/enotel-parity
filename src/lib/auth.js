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
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [
    String(email || '').toLowerCase().trim()
  ])
  const user = rows[0]
  // Compara mesmo sem usuario, contra um hash descartavel de formato valido,
  // para nao vazar quais e-mails existem pelo tempo de resposta.
  const hash = user?.password_hash || DUMMY_HASH
  const ok = await bcrypt.compare(String(password || ''), hash).catch(() => false)
  if (!user || !ok) return null

  const token = jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    config.jwtSecret,
    { expiresIn: TOKEN_TTL }
  )
  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } }
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

export async function audit (actor, action, detail = null) {
  await query('INSERT INTO audit_log (actor, action, detail) VALUES ($1,$2,$3)', [
    actor, action, detail ? JSON.stringify(detail) : null
  ]).catch(() => {})
}
