import { Router } from 'express'
import {
  login, requireAuth, scopeTenant, requireRole, requireTenantContext,
  audit, hashPassword, verifyPassword, genToken, hashToken
} from '../lib/auth.js'
import { query } from '../db/pool.js'
import * as reports from '../services/reports.js'
import * as scanner from '../services/scanner.js'
import * as uazapi from '../services/uazapi.js'
import * as notifier from '../services/notifier.js'
import * as serp from '../services/serpapi.js'
import { getSettings, updateSetting } from '../services/settings.js'
import { provisionTenant, ProvisionError } from '../services/provisioning.js'
import { matchChannel } from '../services/parity.js'
import { computeAutoPeriods, ensureAutoTargets } from '../jobs/autoTargets.js'
import { getUsage, forecast, fetchAccount, syncWithProvider } from '../lib/budget.js'
import { config } from '../config.js'

export const router = Router()

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const num = (v, d) => {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : d
}

// ─── Validacao de onboarding ─────────────────────────────────────────────────
// Slug/branding de tenant sao validados no provisionTenant (services/provisioning.js),
// fonte unica compartilhada com a CLI. Aqui ficam so os validadores das rotas de
// usuario/convite/branding-update.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const HEX_RX = /^#[0-9a-f]{6}$/i
const MIN_PASSWORD = 10
const TENANT_ROLES = ['tenant_admin', 'viewer']

const normEmail = (v) => String(v || '').toLowerCase().trim()

// Branding e superficie de STORED-XSS (Bastiao §2): aceita SO chaves conhecidas,
// logo_url https (nunca javascript:/data:), cores hex estrito. O front aplica o
// branding SO como valor CSS / atributo `src`, NUNCA via innerHTML.
function sanitizeBranding (input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Branding invalido' }
  }
  const out = {}
  if (input.logo_url != null && input.logo_url !== '') {
    const url = String(input.logo_url).trim()
    if (!/^https:\/\//i.test(url)) return { ok: false, error: 'logo_url precisa ser uma URL https' }
    out.logo_url = url
  }
  for (const key of ['primary_color', 'accent_color', 'sidebar_color']) {
    if (input[key] != null && input[key] !== '') {
      if (!HEX_RX.test(String(input[key]))) return { ok: false, error: `${key} precisa ser cor hex (#RRGGBB)` }
      out[key] = String(input[key]).toLowerCase()
    }
  }
  if (input.company_name != null) out.company_name = String(input.company_name).slice(0, 80)
  return { ok: true, value: out }
}

// Gera um convite (ou reset): grava so o SHA-256; devolve o token cru uma vez.
async function createInviteRow ({ tenantId, email, name = null, role, purpose = 'invite', ttlHours = 72, createdBy = null }) {
  const raw = genToken()
  const { rows } = await query(
    `INSERT INTO invites (tenant_id, email, name, role, token_hash, purpose, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval, $8)
     RETURNING id, tenant_id, email, role, purpose, expires_at`,
    [tenantId, normEmail(email), name, role, hashToken(raw), purpose, String(ttlHours), createdBy]
  )
  return { invite: rows[0], token: raw, path: `/convite/${raw}` }
}

// ─── Autenticacao ────────────────────────────────────────────────────────────
router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {}
  const result = await login(email, password)
  if (!result) return res.status(401).json({ error: 'E-mail ou senha invalidos' })
  await audit(result.user.tenant_id, result.user.id, result.user.email, 'login')
  res.json(result)
}))

// Redefinicao de senha (publico). Resposta SEMPRE generica p/ nao revelar quais
// e-mails existem (mesma filosofia do DUMMY_HASH no login).
router.post('/auth/forgot', wrap(async (req, res) => {
  const email = normEmail(req.body?.email)
  const done = () => res.json({ ok: true, message: 'Se o e-mail existir, enviaremos instrucoes' })
  if (!EMAIL_RX.test(email)) return done()
  const { rows } = await query('SELECT id, tenant_id FROM users WHERE email = $1 AND active = TRUE', [email])
  const u = rows[0]
  if (!u || !Number.isInteger(u.tenant_id)) return done()
  const { token } = await createInviteRow({ tenantId: u.tenant_id, email, role: 'viewer', purpose: 'password_reset', ttlHours: 1 })
  // Sem entrega de e-mail na F1: loga o link no servidor p/ o operador repassar.
  console.log(`[reset] link de redefinicao para ${email}: /convite/${token}`)
  await audit(u.tenant_id, u.id, email, 'password.reset.request')
  done()
}))

// Consulta de convite (publico) — a tela de aceite pre-preenche a partir daqui.
router.get('/invites/:token', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT i.email, i.role, i.purpose, t.name AS tenant_name
       FROM invites i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
    [hashToken(req.params.token)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Convite invalido ou expirado' })
  res.json(rows[0])
}))

// Aceite de convite / reset (publico). Consumo ATOMICO do token: o UPDATE so casa
// se ainda valido -> vencedor unico em corrida, uso unico garantido.
router.post('/invites/:token/accept', wrap(async (req, res) => {
  const { name, password } = req.body || {}
  if (String(password || '').length < MIN_PASSWORD) {
    return res.status(400).json({ error: `A senha precisa de ao menos ${MIN_PASSWORD} caracteres` })
  }
  const { rows } = await query(
    `UPDATE invites SET accepted_at = now()
      WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
      RETURNING tenant_id, email, name, role, purpose`,
    [hashToken(req.params.token)]
  )
  const inv = rows[0]
  if (!inv) return res.status(400).json({ error: 'Convite invalido ou expirado' })

  const hash = await hashPassword(password)
  if (inv.purpose === 'password_reset') {
    // NAO reativa: um reset dentro do TTL nao pode ressuscitar conta desativada
    // (login recusa active=false). So troca o hash. Bastiao (minor a).
    await query('UPDATE users SET password_hash = $2 WHERE tenant_id = $1 AND email = $3',
      [inv.tenant_id, hash, inv.email])
    await audit(inv.tenant_id, null, inv.email, 'password.reset.complete')
  } else {
    // ON CONFLICT DO NOTHING: e-mail e unico global — um convite nunca sobrescreve
    // a senha de uma conta que ja exista (login abaixo falharia e retorna 409).
    await query(
      `INSERT INTO users (email, password_hash, name, role, tenant_id, active)
       VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT (email) DO NOTHING`,
      [inv.email, hash, String(name || inv.name || inv.email).trim(), inv.role, inv.tenant_id]
    )
    await audit(inv.tenant_id, null, inv.email, 'invite.accept', { role: inv.role })
  }
  const result = await login(inv.email, password)
  if (!result) return res.status(409).json({ error: 'Nao foi possivel concluir o cadastro' })
  res.json(result)
}))

router.get('/auth/me', requireAuth, (req, res) => {
  const { sub, email, name, role, tenant_id, tenant_slug } = req.user
  res.json({ user: { id: sub, email, name, role, tenant_id, tenant_slug } })
})

// Tudo abaixo exige sessao + tenant resolvido no `req.tenantId`.
router.use(requireAuth, scopeTenant)

// ─── Contexto do tenant (white-label p/ o front) ─────────────────────────────
router.get('/tenant', wrap(async (req, res) => {
  if (!Number.isInteger(req.tenantId)) return res.json({ tenant: null }) // superadmin sem contexto
  const { rows } = await query('SELECT id, slug, name, branding, active FROM tenants WHERE id = $1', [req.tenantId])
  res.json({ tenant: rows[0] || null })
}))

// Trocar a propria senha.
router.post('/auth/password', wrap(async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {}
  if (String(next || '').length < MIN_PASSWORD) {
    return res.status(400).json({ error: `A nova senha precisa de ao menos ${MIN_PASSWORD} caracteres` })
  }
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub])
  if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) {
    return res.status(403).json({ error: 'Senha atual incorreta' })
  }
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.sub, await hashPassword(next)])
  await audit(req.tenantId, req.user.sub, req.user.email, 'password.change')
  res.json({ ok: true })
}))

// ─── Tenants (plataforma — superadmin) ───────────────────────────────────────
router.get('/tenants', requireRole('superadmin'), wrap(async (req, res) => {
  const { rows } = await query('SELECT id, slug, name, active, created_at FROM tenants ORDER BY id')
  res.json(rows)
}))

router.post('/tenants', requireRole('superadmin'), wrap(async (req, res) => {
  // GUARD tenant #2 (fail-closed): enquanto QUALQUER data table canary ainda tiver
  // tenant_id DEFAULT, a camada de dados nao esta 100% cortada -> recusa provisionar.
  // So libera apos o cutover do Cortex (dropar o DEFAULT em TODAS as tabelas), que
  // por sua vez so ocorre apos reports/settings escopados + matriz HTTP verde (ordem
  // travada com Bastiao, §14.1). Ate la, so o tenant #1 (Enotel).
  const { rows: defs } = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE column_name = 'tenant_id' AND column_default IS NOT NULL
        AND table_name IN ('findings','rates','targets','scans','channels','subjects')
      LIMIT 1`
  )
  if (defs[0]) {
    return res.status(409).json({ error: 'Provisionamento de novos clientes bloqueado ate o cutover multi-tenant' })
  }

  // Fonte UNICA de provisionamento (mesma que a CLI add-tenant, services/provisioning.js):
  // tenant + connectors + canais do vertical + admin (senha direta ou convite), tudo
  // transacional e com tenant_id explicito. Validacao (slug/branding/email/senha) e 409
  // de duplicado vem de la via ProvisionError.
  try {
    const result = await provisionTenant(req.body || {})
    await audit(result.tenant.id, req.user.sub, req.user.email, 'tenant.create', {
      slug: result.tenant.slug, admin: result.admin?.mode
    })
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof ProvisionError) return res.status(err.status || 400).json({ error: err.message })
    throw err
  }
}))

router.get('/tenants/:id', requireRole('superadmin'), wrap(async (req, res) => {
  const { rows } = await query('SELECT id, slug, name, branding, active, created_at FROM tenants WHERE id = $1', [num(req.params.id)])
  if (!rows[0]) return res.status(404).json({ error: 'Cliente nao encontrado' })
  res.json(rows[0])
}))

router.patch('/tenants/:id', requireRole('superadmin'), wrap(async (req, res) => {
  const { name, active } = req.body || {}
  const { rows } = await query(
    `UPDATE tenants SET name = COALESCE($2, name), active = COALESCE($3, active)
      WHERE id = $1 RETURNING id, slug, name, branding, active, created_at`,
    [num(req.params.id), name != null ? String(name).trim() : null, typeof active === 'boolean' ? active : null]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Cliente nao encontrado' })
  await audit(rows[0].id, req.user.sub, req.user.email, 'tenant.update', { active: rows[0].active })
  res.json(rows[0])
}))

// Branding: superadmin (qualquer) ou tenant_admin do PROPRIO tenant.
router.patch('/tenants/:id/branding', requireRole('tenant_admin'), wrap(async (req, res) => {
  const id = num(req.params.id)
  if (req.user.role !== 'superadmin' && id !== req.tenantId) {
    return res.status(403).json({ error: 'Permissao insuficiente' })
  }
  const brand = sanitizeBranding(req.body ?? {})
  if (!brand.ok) return res.status(400).json({ error: brand.error })
  const { rows } = await query(
    'UPDATE tenants SET branding = $2 WHERE id = $1 RETURNING id, slug, name, branding, active',
    [id, JSON.stringify(brand.value)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Cliente nao encontrado' })
  await audit(id, req.user.sub, req.user.email, 'tenant.branding')
  res.json(rows[0])
}))

// ─── Usuarios do tenant (tenant_admin) ───────────────────────────────────────
router.get('/users', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { rows } = await query(
    'SELECT id, email, name, role, active, created_at FROM users WHERE tenant_id = $1 ORDER BY id',
    [req.tenantId]
  )
  res.json(rows)
}))

// Cria (convida) um novo usuario: o registro nasce no aceite do convite.
router.post('/users', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { email, name, role = 'viewer' } = req.body || {}
  const e = normEmail(email)
  if (!EMAIL_RX.test(e)) return res.status(400).json({ error: 'Informe um e-mail valido' })
  if (!TENANT_ROLES.includes(role)) return res.status(400).json({ error: 'Papel invalido' })
  if ((await query('SELECT 1 FROM users WHERE email = $1', [e])).rows[0]) {
    return res.status(409).json({ error: 'Ja existe um usuario com esse e-mail' })
  }
  const created = await createInviteRow({ tenantId: req.tenantId, email: e, name, role, createdBy: req.user.sub })
  await audit(req.tenantId, req.user.sub, req.user.email, 'invite.create', { email: e, role })
  res.status(201).json({ email: e, role, expires_at: created.invite.expires_at, path: created.path, token: created.token })
}))

router.patch('/users/:id', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const id = num(req.params.id)
  const { rows: cur } = await query('SELECT id, role, active FROM users WHERE id = $1 AND tenant_id = $2', [id, req.tenantId])
  const target = cur[0]
  if (!target) return res.status(404).json({ error: 'Usuario nao encontrado' })

  const nextRole = req.body?.role
  const nextActive = typeof req.body?.active === 'boolean' ? req.body.active : null
  if (nextRole != null && !TENANT_ROLES.includes(nextRole)) return res.status(400).json({ error: 'Papel invalido' })

  // Anti-lockout (Bastiao §8): nao rebaixar/desativar o ULTIMO tenant_admin ativo.
  const losesAdmin = target.role === 'tenant_admin' && ((nextRole && nextRole !== 'tenant_admin') || nextActive === false)
  if (losesAdmin) {
    const { rows: c } = await query(
      "SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'tenant_admin' AND active = TRUE",
      [req.tenantId]
    )
    if (c[0].n <= 1) return res.status(400).json({ error: 'Nao e possivel remover o ultimo administrador do cliente' })
  }
  const { rows } = await query(
    `UPDATE users SET name = COALESCE($3, name), role = COALESCE($4, role), active = COALESCE($5, active)
      WHERE id = $1 AND tenant_id = $2 RETURNING id, email, name, role, active`,
    [id, req.tenantId, req.body?.name != null ? String(req.body.name).trim() : null, nextRole ?? null, nextActive]
  )
  await audit(req.tenantId, req.user.sub, req.user.email, 'user.update', { id, role: rows[0].role, active: rows[0].active })
  res.json(rows[0])
}))

router.delete('/users/:id', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const id = num(req.params.id)
  if (id === req.user.sub) return res.status(400).json({ error: 'Voce nao pode desativar a si mesmo' })
  const { rows: cur } = await query('SELECT role FROM users WHERE id = $1 AND tenant_id = $2', [id, req.tenantId])
  if (!cur[0]) return res.status(404).json({ error: 'Usuario nao encontrado' })
  if (cur[0].role === 'tenant_admin') {
    const { rows: c } = await query(
      "SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'tenant_admin' AND active = TRUE",
      [req.tenantId]
    )
    if (c[0].n <= 1) return res.status(400).json({ error: 'Nao e possivel remover o ultimo administrador do cliente' })
  }
  await query('UPDATE users SET active = FALSE WHERE id = $1 AND tenant_id = $2', [id, req.tenantId])
  await audit(req.tenantId, req.user.sub, req.user.email, 'user.deactivate', { id })
  res.json({ ok: true })
}))

// Admin dispara um convite de redefinicao de senha p/ um usuario do tenant.
router.post('/users/:id/password/reset', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { rows } = await query('SELECT email FROM users WHERE id = $1 AND tenant_id = $2 AND active = TRUE', [num(req.params.id), req.tenantId])
  if (!rows[0]) return res.status(404).json({ error: 'Usuario nao encontrado' })
  const created = await createInviteRow({ tenantId: req.tenantId, email: rows[0].email, role: 'viewer', purpose: 'password_reset', ttlHours: 1, createdBy: req.user.sub })
  await audit(req.tenantId, req.user.sub, req.user.email, 'password.reset.request', { id: num(req.params.id) })
  res.json({ email: rows[0].email, path: created.path, token: created.token })
}))

// ─── Painel e relatorios ─────────────────────────────────────────────────────
router.get('/overview', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.overview({ tenantId: req.tenantId }))
}))

router.get('/trend', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.priceTrend({
    days: num(req.query.days, 30),
    targetId: req.query.target ? num(req.query.target, null) : null,
    tenantId: req.tenantId
  }))
}))

router.get('/compliance', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.channelCompliance({ days: num(req.query.days, 30), tenantId: req.tenantId }))
}))

router.get('/heatmap', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.violationHeatmap({ days: num(req.query.days, 30), tenantId: req.tenantId }))
}))

router.get('/findings', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.listFindings({
    days: num(req.query.days, 30),
    severity: req.query.severity || null,
    channel: req.query.channel || null,
    status: req.query.status || null,
    limit: num(req.query.limit, 200),
    tenantId: req.tenantId
  }))
}))

router.patch('/findings/:id', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { status } = req.body || {}
  if (!['open', 'acknowledged', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Status invalido' })
  }
  const { rows } = await query(
    'UPDATE findings SET status = $2 WHERE id = $1 AND tenant_id = $3 RETURNING id, status',
    [num(req.params.id), status, req.tenantId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Achado nao encontrado' })
  await audit(req.tenantId, req.user.sub, req.user.email, 'finding.status', { id: rows[0].id, status })
  res.json(rows[0])
}))

router.get('/rates/current', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.currentRates({ tenantId: req.tenantId }))
}))

router.get('/report', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.fullReport({ days: num(req.query.days, 30), tenantId: req.tenantId }))
}))

router.get('/report/csv', requireTenantContext, wrap(async (req, res) => {
  const findings = await reports.listFindings({ days: num(req.query.days, 30), limit: 5000, tenantId: req.tenantId })
  const csv = reports.findingsToCsv(findings)
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="paridade-enotel-${stamp}.csv"`)
  res.send(csv)
}))

// ─── Varreduras ──────────────────────────────────────────────────────────────
router.get('/scans', requireTenantContext, wrap(async (req, res) => {
  res.json(await reports.scanHistory({ limit: num(req.query.limit, 30), tenantId: req.tenantId }))
}))

router.post('/scans/run', requireRole('tenant_admin'), wrap(async (req, res) => {
  if (scanner.isRunning()) {
    return res.status(409).json({ error: 'Uma varredura ja esta em andamento' })
  }
  await audit(req.tenantId, req.user.sub, req.user.email, 'scan.manual')
  // Responde na hora: uma varredura leva dezenas de segundos e nao deve
  // segurar a requisicao do navegador.
  res.status(202).json({ started: true })
  // Escopa ao tenant do requisitante (tenant_admin). superadmin sem contexto
  // (tenantId null) roda global, como o agendador.
  scanner.runScan({ trigger: 'manual', tenantId: req.tenantId }).catch((err) => {
    console.error('[scan] falhou:', err.message)
  })
}))

router.get('/budget', wrap(async (req, res) => {
  res.json(await forecast())
}))

router.post('/budget/sync', requireRole('tenant_admin'), wrap(async (req, res) => {
  const result = await syncWithProvider()
  await audit(req.tenantId, req.user.sub, req.user.email, 'budget.sync', result)
  res.json({ ...result, usage: await forecast() })
}))

/**
 * Diagnostico da integracao. Sem `?live=1` nao gasta nenhuma requisicao:
 * o endpoint /account da SerpAPI e gratuito.
 */
router.get('/serpapi/diagnose', requireTenantContext, wrap(async (req, res) => {
  const out = { steps: [] }

  out.steps.push({
    step: 'Chave configurada',
    ok: Boolean(config.serpapi.key),
    detail: config.serpapi.key
      ? `termina em ...${config.serpapi.key.slice(-6)}`
      : 'SERPAPI_KEY vazia nas variaveis de ambiente'
  })

  const account = await fetchAccount({ force: true })
  out.steps.push({
    step: 'Conta SerpAPI acessivel',
    ok: account.ok,
    detail: account.ok
      ? `plano ${account.planName} · ${account.thisMonthUsage} usadas no mes · ${account.totalSearchesLeft} restantes`
      : account.error
  })
  out.account = account

  const { rows: targets } = await query(
    `SELECT t.id, t.label, t.mode, t.check_in, t.check_out, t.horizon_days,
            t.los, t.adults, t.active,
            p.name AS property_name, p.serp_query, p.serp_property_token
     FROM targets t JOIN subjects p ON p.id = t.property_id
     WHERE t.active AND p.active AND t.tenant_id = $1
     ORDER BY COALESCE(t.check_in, CURRENT_DATE + t.horizon_days)`,
    [req.tenantId]
  )
  out.steps.push({
    step: 'Alvos ativos',
    ok: targets.length > 0,
    detail: targets.length > 0
      ? `${targets.length} alvo(s) · ${targets.length} requisicao(oes) por varredura`
      : 'Nenhum alvo ativo — a varredura nao tem o que consultar'
  })
  out.targets = targets

  const { rows: lastScan } = await query('SELECT * FROM scans WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1', [req.tenantId])
  out.lastScan = lastScan[0] || null
  out.steps.push({
    step: 'Ultima varredura',
    ok: Boolean(lastScan[0]) && lastScan[0].status !== 'failed',
    detail: lastScan[0]
      ? `#${lastScan[0].id} · ${lastScan[0].status} · ${lastScan[0].message || 'sem erros'}`
      : 'Nenhuma varredura executada ainda'
  })

  // Busca real: 1-2 requisicoes. So roda quando pedido explicitamente.
  if (req.query.live === '1' && targets.length > 0 && account.ok) {
    const target = targets[0]
    try {
      const probe = await serp.probe(target)
      const { rows: channels } = await query('SELECT * FROM channels WHERE active AND tenant_id = $1', [req.tenantId])
      out.probe = {
        ...probe,
        offers: probe.offers.map((o) => {
          const ch = matchChannel(o.source, channels)
          return {
            source: o.source,
            price: o.price,
            matchedChannel: ch ? ch.name : null,
            ignored: !ch
          }
        })
      }
      out.steps.push({
        step: 'Busca real no Google Hotels',
        ok: probe.offers.length > 0,
        detail: `${probe.offers.length} oferta(s) · ${out.probe.offers.filter((o) => !o.ignored).length} casadas com canais monitorados`
      })
    } catch (err) {
      out.steps.push({ step: 'Busca real no Google Hotels', ok: false, detail: err.message })
    }
  }

  out.ok = out.steps.every((s) => s.ok)
  res.json(out)
}))

// ─── Propriedades e alvos ────────────────────────────────────────────────────
router.get('/properties', requireTenantContext, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*,
            COALESCE(json_agg(t.* ORDER BY t.horizon_days)
                     FILTER (WHERE t.id IS NOT NULL), '[]') AS targets
     FROM subjects p
     LEFT JOIN targets t ON t.property_id = p.id AND t.tenant_id = p.tenant_id
     WHERE p.tenant_id = $1
     GROUP BY p.id ORDER BY p.id`,
    [req.tenantId]
  )
  res.json(rows)
}))

// Periodos que a geracao automatica criaria agora -- para a tela mostrar antes
// de o usuario ligar a opcao.
router.get('/targets/auto/preview', requireTenantContext, wrap(async (req, res) => {
  const settings = await getSettings(req.tenantId)
  res.json({
    enabled: settings.auto_targets.enabled,
    adults: settings.auto_targets.adults,
    periods: computeAutoPeriods()
  })
}))

router.post('/targets/auto/generate', requireRole('tenant_admin'), wrap(async (req, res) => {
  const result = await ensureAutoTargets({ force: true, tenantId: req.tenantId })
  await audit(req.tenantId, req.user.sub, req.user.email, 'targets.auto.generate', result)
  res.json(result)
}))

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/

router.post('/targets', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { property_id, label, mode = 'rolling', horizon_days, los = 2, adults = 2,
    check_in: checkIn, check_out: checkOut } = req.body || {}

  if (!property_id) return res.status(400).json({ error: 'Informe a propriedade' })
  if (!['rolling', 'fixed'].includes(mode)) {
    return res.status(400).json({ error: 'Modo invalido' })
  }
  // A propriedade precisa ser DO tenant (senao B criaria alvo na propriedade de A).
  if (!(await query('SELECT 1 FROM subjects WHERE id = $1 AND tenant_id = $2', [property_id, req.tenantId])).rows[0]) {
    return res.status(404).json({ error: 'Propriedade nao encontrada' })
  }

  if (mode === 'fixed') {
    if (!DATE_RX.test(String(checkIn)) || !DATE_RX.test(String(checkOut))) {
      return res.status(400).json({ error: 'Informe check-in e check-out no formato AAAA-MM-DD' })
    }
    if (checkOut <= checkIn) {
      return res.status(400).json({ error: 'O check-out precisa ser depois do check-in' })
    }
    // Uma data que ja passou nao tem oferta: seria requisicao jogada fora.
    const today = new Date().toISOString().slice(0, 10)
    if (checkIn < today) {
      return res.status(400).json({ error: 'O check-in nao pode ser uma data passada' })
    }

    const nights = Math.round(
      (new Date(`${checkOut}T12:00:00Z`) - new Date(`${checkIn}T12:00:00Z`)) / 86400000
    )
    const auto = `${checkIn.split('-').reverse().slice(0, 2).join('/')} · ${nights} ${nights === 1 ? 'noite' : 'noites'}`

    const { rows } = await query(
      `INSERT INTO targets (tenant_id, property_id, label, mode, check_in, check_out, los, adults)
       VALUES ($1,$2,$3,'fixed',$4,$5,$6,$7)
       ON CONFLICT (property_id, check_in, check_out, adults) WHERE mode = 'fixed'
         DO UPDATE SET label = EXCLUDED.label, active = TRUE
       RETURNING *`,
      [req.tenantId, property_id, label?.trim() || auto, checkIn, checkOut, nights, adults]
    )
    await audit(req.tenantId, req.user.sub, req.user.email, 'target.create', rows[0])
    return res.json(rows[0])
  }

  if (!Number.isFinite(Number(horizon_days)) || Number(horizon_days) < 1) {
    return res.status(400).json({ error: 'Informe o numero de dias da janela movel' })
  }
  const { rows } = await query(
    `INSERT INTO targets (tenant_id, property_id, label, mode, horizon_days, los, adults)
     VALUES ($1,$2,$3,'rolling',$4,$5,$6)
     ON CONFLICT (property_id, horizon_days, los, adults)
       DO UPDATE SET label = EXCLUDED.label, active = TRUE
     RETURNING *`,
    [req.tenantId, property_id, label?.trim() || `Janela de ${horizon_days} dias`, horizon_days, los, adults]
  )
  await audit(req.tenantId, req.user.sub, req.user.email, 'target.create', rows[0])
  res.json(rows[0])
}))

router.patch('/targets/:id', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { active } = req.body || {}
  const { rows } = await query(
    'UPDATE targets SET active = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *',
    [num(req.params.id), Boolean(active), req.tenantId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Alvo nao encontrado' })
  res.json(rows[0])
}))

router.delete('/targets/:id', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { rowCount } = await query('DELETE FROM targets WHERE id = $1 AND tenant_id = $2', [num(req.params.id), req.tenantId])
  if (!rowCount) return res.status(404).json({ error: 'Alvo nao encontrado' })
  await audit(req.tenantId, req.user.sub, req.user.email, 'target.delete', { id: req.params.id })
  res.json({ deleted: true })
}))

router.get('/channels', requireTenantContext, wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM channels WHERE tenant_id = $1 ORDER BY sort_order', [req.tenantId])
  res.json(rows)
}))

// ─── WhatsApp ────────────────────────────────────────────────────────────────
router.get('/whatsapp/status', wrap(async (req, res) => {
  if (!uazapi.isConfigured()) {
    return res.json({ configured: false, connected: false, reason: 'UAZAPI_URL nao definida' })
  }
  const token = await uazapi.instanceToken()
  if (!token) return res.json({ configured: true, connected: false, instance: false })

  try {
    const status = await uazapi.getStatus()
    res.json({ configured: true, instance: true, ...status })
  } catch (err) {
    res.json({ configured: true, instance: true, connected: false, error: err.message })
  }
}))

router.post('/whatsapp/instance', requireRole('tenant_admin'), wrap(async (req, res) => {
  const result = await uazapi.initInstance(req.body?.name || 'enotel-paridade')
  await audit(req.tenantId, req.user.sub, req.user.email, 'whatsapp.instance', { reused: result.reused })
  res.json(result)
}))

router.post('/whatsapp/connect', requireRole('tenant_admin'), wrap(async (req, res) => {
  res.json(await uazapi.connect({ phone: req.body?.phone }))
}))

router.post('/whatsapp/disconnect', requireRole('tenant_admin'), wrap(async (req, res) => {
  await uazapi.disconnect()
  await audit(req.tenantId, req.user.sub, req.user.email, 'whatsapp.disconnect')
  res.json({ ok: true })
}))

router.get('/whatsapp/contacts', wrap(async (req, res) => {
  res.json(await uazapi.listContacts({
    search: req.query.search || '',
    limit: num(req.query.limit, 200)
  }))
}))

router.get('/whatsapp/recipients', requireTenantContext, wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM whatsapp_recipients WHERE tenant_id = $1 ORDER BY created_at', [req.tenantId])
  res.json(rows)
}))

router.post('/whatsapp/recipients', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { name, phone, jid, is_group = false } = req.body || {}
  const digits = String(phone || '').replace(/\D/g, '')
  if (!name || (!digits && !jid)) {
    return res.status(400).json({ error: 'Informe nome e telefone (ou jid do grupo)' })
  }
  const { rows } = await query(
    // ON CONFLICT (tenant_id, phone): a unique composta impede que o tenant B
    // "casse" a linha de A ao reenviar um phone de A (antes, UNIQUE(phone) global
    // + upsert sequestrava a linha do A). Bastiao/Cortex — sobe no mesmo commit
    // da unique composta em schema.sql.
    `INSERT INTO whatsapp_recipients (tenant_id, name, phone, jid, is_group)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name, jid = EXCLUDED.jid, active = TRUE
     RETURNING *`,
    [req.tenantId, name, digits || jid, jid || null, Boolean(is_group)]
  )
  await audit(req.tenantId, req.user.sub, req.user.email, 'whatsapp.recipient.add', { name, phone: digits })
  res.json(rows[0])
}))

router.patch('/whatsapp/recipients/:id', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { rows } = await query(
    'UPDATE whatsapp_recipients SET active = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *',
    [num(req.params.id), Boolean(req.body?.active), req.tenantId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Destinatario nao encontrado' })
  res.json(rows[0])
}))

router.delete('/whatsapp/recipients/:id', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  const { rowCount } = await query('DELETE FROM whatsapp_recipients WHERE id = $1 AND tenant_id = $2', [num(req.params.id), req.tenantId])
  if (!rowCount) return res.status(404).json({ error: 'Destinatario nao encontrado' })
  await audit(req.tenantId, req.user.sub, req.user.email, 'whatsapp.recipient.remove', { id: req.params.id })
  res.json({ deleted: true })
}))

router.post('/whatsapp/test', requireRole('tenant_admin'), wrap(async (req, res) => {
  const to = req.body?.to
  if (!to) return res.status(400).json({ error: 'Informe o destino' })
  await notifier.sendTest(to)
  await audit(req.tenantId, req.user.sub, req.user.email, 'whatsapp.test', { to })
  res.json({ ok: true })
}))

router.get('/whatsapp/notifications', requireTenantContext, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, r.name AS recipient_name
     FROM notifications n LEFT JOIN whatsapp_recipients r ON r.id = n.recipient_id
     WHERE n.tenant_id = $2
     ORDER BY n.created_at DESC LIMIT $1`,
    [num(req.query.limit, 50), req.tenantId]
  )
  res.json(rows)
}))

// ─── Configuracoes ───────────────────────────────────────────────────────────
router.get('/settings', requireTenantContext, wrap(async (req, res) => {
  const s = await getSettings(req.tenantId)
  // O token da instancia nunca sai para o navegador.
  const { instance_token: _omit, ...whatsapp } = s.whatsapp
  res.json({ ...s, whatsapp, usage: await getUsage() })
}))

router.patch('/settings/:key', requireRole('tenant_admin'), requireTenantContext, wrap(async (req, res) => {
  if (req.params.key === 'whatsapp') {
    return res.status(403).json({ error: 'Configuracao gerida pela conexao do WhatsApp' })
  }
  const merged = await updateSetting(req.params.key, req.body || {}, req.tenantId)
  await audit(req.tenantId, req.user.sub, req.user.email, 'settings.update', { key: req.params.key })
  res.json(merged)
}))
