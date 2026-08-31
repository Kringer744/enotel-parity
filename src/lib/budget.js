import { query } from '../db/pool.js'
import { config } from '../config.js'

export function currentMonth (d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function getUsage (month = currentMonth()) {
  const { rows } = await query(
    'SELECT used FROM api_usage WHERE month = $1',
    [month]
  )
  const used = rows[0]?.used ?? 0
  const limit = config.serpapi.monthlyLimit
  const reserve = config.serpapi.reserve
  return {
    month,
    used,
    limit,
    reserve,
    remaining: Math.max(0, limit - used),
    // O agendador so pode gastar ate o limite MENOS a reserva; a reserva fica
    // para disparos manuais quando algo suspeito aparece no meio do mes.
    scheduledRemaining: Math.max(0, limit - reserve - used),
    pctUsed: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0
  }
}

/**
 * Reserva `count` requisicoes de forma atomica. Retorna false se estourar o
 * teto -- o incremento acontece ANTES da chamada HTTP, entao duas varreduras
 * concorrentes nunca ultrapassam o limite juntas.
 */
export async function consume (count = 1, { allowReserve = false } = {}) {
  const month = currentMonth()
  const ceiling = allowReserve
    ? config.serpapi.monthlyLimit
    : config.serpapi.monthlyLimit - config.serpapi.reserve

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

  // Sem linha devolvida = o WHERE do DO UPDATE barrou: orcamento esgotado.
  // (O caso INSERT puro so passa se count <= ceiling, checado abaixo.)
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
  const dayOfMonth = now.getUTCDate()
  const daysLeft = daysInMonth - dayOfMonth

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
    // Quantos alvos por varredura cabem no que resta
    maxTargetsPerScan: daysLeft > 0
      ? Math.floor(usage.scheduledRemaining / daysLeft)
      : perScan
  }
}
