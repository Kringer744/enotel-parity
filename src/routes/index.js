import { Router } from 'express'
import { login, requireAuth, audit } from '../lib/auth.js'
import { query } from '../db/pool.js'
import * as reports from '../services/reports.js'
import * as scanner from '../services/scanner.js'
import * as uazapi from '../services/uazapi.js'
import * as notifier from '../services/notifier.js'
import { getSettings, updateSetting } from '../services/settings.js'
import { matchChannel } from '../services/parity.js'
import { getUsage, forecast, fetchAccount, syncWithProvider } from '../lib/budget.js'
import { config } from '../config.js'

export const router = Router()

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const num = (v, d) => {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : d
}

// ─── Autenticacao ────────────────────────────────────────────────────────────
router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {}
  const result = await login(email, password)
  if (!result) return res.status(401).json({ error: 'E-mail ou senha invalidos' })
  await audit(result.user.email, 'login')
  res.json(result)
}))

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.sub, email: req.user.email, name: req.user.name, role: req.user.role } })
})

// Tudo abaixo exige sessao.
router.use(requireAuth)

// ─── Painel e relatorios ─────────────────────────────────────────────────────
router.get('/overview', wrap(async (req, res) => {
  res.json(await reports.overview())
}))

router.get('/trend', wrap(async (req, res) => {
  res.json(await reports.priceTrend({
    days: num(req.query.days, 30),
    targetId: req.query.target ? num(req.query.target, null) : null
  }))
}))

router.get('/compliance', wrap(async (req, res) => {
  res.json(await reports.channelCompliance({ days: num(req.query.days, 30) }))
}))

router.get('/heatmap', wrap(async (req, res) => {
  res.json(await reports.violationHeatmap({ days: num(req.query.days, 30) }))
}))

router.get('/findings', wrap(async (req, res) => {
  res.json(await reports.listFindings({
    days: num(req.query.days, 30),
    severity: req.query.severity || null,
    channel: req.query.channel || null,
    status: req.query.status || null,
    limit: num(req.query.limit, 200)
  }))
}))

router.patch('/findings/:id', wrap(async (req, res) => {
  const { status } = req.body || {}
  if (!['open', 'acknowledged', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Status invalido' })
  }
  const { rows } = await query(
    'UPDATE findings SET status = $2 WHERE id = $1 RETURNING id, status',
    [num(req.params.id), status]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Achado nao encontrado' })
  await audit(req.user.email, 'finding.status', { id: rows[0].id, status })
  res.json(rows[0])
}))

router.get('/rates/current', wrap(async (req, res) => {
  res.json(await reports.currentRates())
}))

router.get('/report', wrap(async (req, res) => {
  res.json(await reports.fullReport({ days: num(req.query.days, 30) }))
}))

router.get('/report/csv', wrap(async (req, res) => {
  const findings = await reports.listFindings({ days: num(req.query.days, 30), limit: 5000 })
  const csv = reports.findingsToCsv(findings)
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="paridade-enotel-${stamp}.csv"`)
  res.send(csv)
}))

// ─── Varreduras ──────────────────────────────────────────────────────────────
router.get('/scans', wrap(async (req, res) => {
  res.json(await reports.scanHistory({ limit: num(req.query.limit, 30) }))
}))

router.post('/scans/run', wrap(async (req, res) => {
  if (scanner.isRunning()) {
    return res.status(409).json({ error: 'Uma varredura ja esta em andamento' })
  }
  await audit(req.user.email, 'scan.manual')
  // Responde na hora: uma varredura leva dezenas de segundos e nao deve
  // segurar a requisicao do navegador.
  res.status(202).json({ started: true })
  scanner.runScan({ trigger: 'manual' }).catch((err) => {
    console.error('[scan] falhou:', err.message)
  })
}))

router.get('/budget', wrap(async (req, res) => {
  res.json(await forecast())
}))

router.post('/budget/sync', wrap(async (req, res) => {
  const result = await syncWithProvider()
  await audit(req.user.email, 'budget.sync', result)
  res.json({ ...result, usage: await forecast() })
}))

/**
 * Diagnostico da integracao. Sem `?live=1` nao gasta nenhuma requisicao:
 * o endpoint /account da SerpAPI e gratuito.
 */
router.get('/serpapi/diagnose', wrap(async (req, res) => {
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
    `SELECT t.id, t.label, t.horizon_days, t.los, t.adults, t.active,
            p.name AS property_name, p.serp_query, p.serp_property_token
     FROM scan_targets t JOIN properties p ON p.id = t.property_id
     WHERE t.active AND p.active ORDER BY t.horizon_days`
  )
  out.steps.push({
    step: 'Alvos ativos',
    ok: targets.length > 0,
    detail: targets.length > 0
      ? `${targets.length} alvo(s) · ${targets.length} requisicao(oes) por varredura`
      : 'Nenhum alvo ativo — a varredura nao tem o que consultar'
  })
  out.targets = targets

  const { rows: lastScan } = await query('SELECT * FROM scans ORDER BY started_at DESC LIMIT 1')
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
      const { rows: channels } = await query('SELECT * FROM channels WHERE active')
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
router.get('/properties', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*,
            COALESCE(json_agg(t.* ORDER BY t.horizon_days)
                     FILTER (WHERE t.id IS NOT NULL), '[]') AS targets
     FROM properties p
     LEFT JOIN scan_targets t ON t.property_id = p.id
     GROUP BY p.id ORDER BY p.id`
  )
  res.json(rows)
}))

router.post('/targets', wrap(async (req, res) => {
  const { property_id, label, horizon_days, los = 2, adults = 2 } = req.body || {}
  if (!property_id || !label || !Number.isFinite(Number(horizon_days))) {
    return res.status(400).json({ error: 'property_id, label e horizon_days sao obrigatorios' })
  }
  const { rows } = await query(
    `INSERT INTO scan_targets (property_id, label, horizon_days, los, adults)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (property_id, horizon_days, los, adults) DO UPDATE SET label = EXCLUDED.label, active = TRUE
     RETURNING *`,
    [property_id, label, horizon_days, los, adults]
  )
  await audit(req.user.email, 'target.create', rows[0])
  res.json(rows[0])
}))

router.patch('/targets/:id', wrap(async (req, res) => {
  const { active } = req.body || {}
  const { rows } = await query(
    'UPDATE scan_targets SET active = $2 WHERE id = $1 RETURNING *',
    [num(req.params.id), Boolean(active)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Alvo nao encontrado' })
  res.json(rows[0])
}))

router.delete('/targets/:id', wrap(async (req, res) => {
  await query('DELETE FROM scan_targets WHERE id = $1', [num(req.params.id)])
  await audit(req.user.email, 'target.delete', { id: req.params.id })
  res.json({ deleted: true })
}))

router.get('/channels', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM channels ORDER BY sort_order')
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

router.post('/whatsapp/instance', wrap(async (req, res) => {
  const result = await uazapi.initInstance(req.body?.name || 'enotel-paridade')
  await audit(req.user.email, 'whatsapp.instance', { reused: result.reused })
  res.json(result)
}))

router.post('/whatsapp/connect', wrap(async (req, res) => {
  res.json(await uazapi.connect({ phone: req.body?.phone }))
}))

router.post('/whatsapp/disconnect', wrap(async (req, res) => {
  await uazapi.disconnect()
  await audit(req.user.email, 'whatsapp.disconnect')
  res.json({ ok: true })
}))

router.get('/whatsapp/contacts', wrap(async (req, res) => {
  res.json(await uazapi.listContacts({
    search: req.query.search || '',
    limit: num(req.query.limit, 200)
  }))
}))

router.get('/whatsapp/recipients', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM whatsapp_recipients ORDER BY created_at')
  res.json(rows)
}))

router.post('/whatsapp/recipients', wrap(async (req, res) => {
  const { name, phone, jid, is_group = false } = req.body || {}
  const digits = String(phone || '').replace(/\D/g, '')
  if (!name || (!digits && !jid)) {
    return res.status(400).json({ error: 'Informe nome e telefone (ou jid do grupo)' })
  }
  const { rows } = await query(
    `INSERT INTO whatsapp_recipients (name, phone, jid, is_group)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, jid = EXCLUDED.jid, active = TRUE
     RETURNING *`,
    [name, digits || jid, jid || null, Boolean(is_group)]
  )
  await audit(req.user.email, 'whatsapp.recipient.add', { name, phone: digits })
  res.json(rows[0])
}))

router.patch('/whatsapp/recipients/:id', wrap(async (req, res) => {
  const { rows } = await query(
    'UPDATE whatsapp_recipients SET active = $2 WHERE id = $1 RETURNING *',
    [num(req.params.id), Boolean(req.body?.active)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Destinatario nao encontrado' })
  res.json(rows[0])
}))

router.delete('/whatsapp/recipients/:id', wrap(async (req, res) => {
  await query('DELETE FROM whatsapp_recipients WHERE id = $1', [num(req.params.id)])
  await audit(req.user.email, 'whatsapp.recipient.remove', { id: req.params.id })
  res.json({ deleted: true })
}))

router.post('/whatsapp/test', wrap(async (req, res) => {
  const to = req.body?.to
  if (!to) return res.status(400).json({ error: 'Informe o destino' })
  await notifier.sendTest(to)
  await audit(req.user.email, 'whatsapp.test', { to })
  res.json({ ok: true })
}))

router.get('/whatsapp/notifications', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT n.*, r.name AS recipient_name
     FROM notifications n LEFT JOIN whatsapp_recipients r ON r.id = n.recipient_id
     ORDER BY n.created_at DESC LIMIT $1`,
    [num(req.query.limit, 50)]
  )
  res.json(rows)
}))

// ─── Configuracoes ───────────────────────────────────────────────────────────
router.get('/settings', wrap(async (req, res) => {
  const s = await getSettings()
  // O token da instancia nunca sai para o navegador.
  const { instance_token: _omit, ...whatsapp } = s.whatsapp
  res.json({ ...s, whatsapp, usage: await getUsage() })
}))

router.patch('/settings/:key', wrap(async (req, res) => {
  if (req.params.key === 'whatsapp') {
    return res.status(403).json({ error: 'Configuracao gerida pela conexao do WhatsApp' })
  }
  const merged = await updateSetting(req.params.key, req.body || {})
  await audit(req.user.email, 'settings.update', { key: req.params.key })
  res.json(merged)
}))
