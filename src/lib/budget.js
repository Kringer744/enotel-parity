import { query } from '../db/pool.js'
import { config } from '../config.js'

export function currentMonth (d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/* ─── Saldo real na SerpAPI ──────────────────────────────────────────────────
   GET /account NAO consome busca -- e a fonte da verdade sobre os creditos.
   O contador local existe so para reservar cota ANTES da chamada (a SerpAPI
   demora a refletir o consumo e nao serve de trava contra corrida). */

let cache = { at: 0, data: null, error: null }
const CACHE_MS = 60_000

export async function fetchAccount ({ force = false } = {}) {
  if (!config.serpapi.key) {
    return { ok: false, error: 'SERPAPI_KEY nao configurada' }
  }
  if (!force && Date.now() - cache.at < CACHE_MS && cache.data) {
    return { ok: true, ...cache.data, cached: true }
  }

  const url = new URL('https://serpapi.com/account')
  url.searchParams.set('api_key', config.serpapi.key)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)

    const body = await res.json().catch(() => null)
    if (!res.ok || body?.error) {
      const error = body?.error || `HTTP ${res.status}`
      cache = { at: Date.now(), data: cache.data, error }
      return { ok: false, error, stale: cache.data || null }
    }

    const data = {
      planName: body.plan_name || body.plan_id || 'desconhecido',
      searchesPerMonth: Number(body.searches_per_month) || null,
      thisMonthUsage: Number(body.this_month_usage) || 0,
      planSearchesLeft: Number(body.plan_searches_left) || 0,
      extraCredits: Number(body.extra_credits) || 0,
      totalSearchesLeft: Number(body.total_searches_left) || 0,
      thisHourSearches: Number(body.this_hour_searches) || 0,
      accountEmail: body.account_email || null
    }
    cache = { at: Date.now(), data, error: null }
    return { ok: true, ...data, cached: false }
  } catch (err) {
    const error = `Falha ao consultar a conta SerpAPI: ${err.message}`
    cache = { at: Date.now(), data: cache.data, error }
    return { ok: false, error, stale: cache.data || null }
  }
}

async function localUsed (month = currentMonth()) {
  const { rows } = await query('SELECT used FROM api_usage WHERE month = $1', [month])
  return rows[0]?.used ?? 0
}

/**
 * Alinha o contador local ao consumo real. Usa o MAIOR dos dois: se alguem
 * gastou a chave fora deste sistema, o local sobe; se estamos no meio de uma
 * varredura (local ja reservou, SerpAPI ainda nao contabilizou), o local manda.
 */
export async function syncWithProvider () {
  const acc = await fetchAccount({ force: true })
  if (!acc.ok) return { synced: false, error: acc.error }

  const month = currentMonth()
  const local = await localUsed(month)
  const real = acc.thisMonthUsage

  if (real > local) {
    await query(
      `INSERT INTO api_usage (month, used, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (month) DO UPDATE SET used = EXCLUDED.used, updated_at = now()`,
      [month, real]
    )
  }
  return { synced: true, local, real, applied: Math.max(local, real) }
}

/** Teto efetivo do mes: o plano real quando conhecido, senao o configurado. */
function effectiveLimit (account) {
  if (account?.ok && account.searchesPerMonth) {
    return account.searchesPerMonth + (account.extraCredits || 0)
  }
  return config.serpapi.monthlyLimit
}

export async function getUsage (month = currentMonth()) {
  const account = await fetchAccount()
  const local = await localUsed(month)

  const limit = effectiveLimit(account)
  const reserve = config.serpapi.reserve
  // O consumo real da SerpAPI manda no que e exibido; o local so o supera
  // durante uma varredura em andamento.
  const used = account.ok ? Math.max(account.thisMonthUsage, local) : local
  const remaining = account.ok
    ? Math.min(account.totalSearchesLeft, Math.max(0, limit - used))
    : Math.max(0, limit - used)

  return {
    month,
    used,
    limit,
    reserve,
    remaining,
    scheduledRemaining: Math.max(0, remaining - reserve),
    pctUsed: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,

    // Transparencia sobre a origem do numero
    live: account.ok,
    liveError: account.ok ? null : (account.error || null),
    localUsed: local,
    providerUsage: account.ok ? account.thisMonthUsage : null,
    providerLeft: account.ok ? account.totalSearchesLeft : null,
    planName: account.ok ? account.planName : null,
    accountEmail: account.ok ? account.accountEmail : null
  }
}

/**
 * Reserva `count` requisicoes de forma atomica ANTES do fetch, para que duas
 * varreduras concorrentes nunca estourem o teto juntas.
 */
export async function consume (count = 1, { allowReserve = false } = {}) {
  const month = currentMonth()
  const account = await fetchAccount()
  const limit = effectiveLimit(account)
  const ceiling = allowReserve ? limit : limit - config.serpapi.reserve

  // Trava adicional: se a propria SerpAPI ja diz que nao ha saldo, nem tenta.
  if (account.ok && account.totalSearchesLeft < count) return false

  const { rows } = await query(
    `INSERT INTO api_usage (month, used, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (month) DO UPDATE
       SET used = api_usage.used + EXCLUDED.used,
           updated_at = now()
       WHERE api_usage.used + EXCLUDED.used <= $3
     RETURNING used`,
    [month, count, ceiling]
  )

  if (rows.length === 0) return false
  if (rows[0].used > ceiling) {
    await query('UPDATE api_usage SET used = used - $2 WHERE month = $1', [month, count])
    return false
  }
  return true
}

/** Devolve requisicoes reservadas que nao chegaram a ser gastas. */
export async function refund (count = 1) {
  await query(
    'UPDATE api_usage SET used = GREATEST(0, used - $2), updated_at = now() WHERE month = $1',
    [currentMonth(), count]
  )
}

/** Projeta se o ritmo atual chega ao fim do mes sem estourar. */
export async function forecast () {
  const usage = await getUsage()
  const now = new Date()
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate()
  const daysLeft = daysInMonth - now.getUTCDate()

  const { rows } = await query(
    `SELECT COUNT(*)::int AS targets
     FROM scan_targets t
     JOIN properties p ON p.id = t.property_id
     WHERE t.active AND p.active`
  )
  const perScan = rows[0]?.targets ?? 0
  const projected = usage.used + perScan * daysLeft

  return {
    ...usage,
    perScan,
    daysLeft,
    projected,
    willExceed: projected > usage.limit,
    maxTargetsPerScan: daysLeft > 0
      ? Math.floor(usage.scheduledRemaining / daysLeft)
      : perScan
  }
}
