import { query } from '../db/pool.js'

const DEFAULTS = {
  parity: {
    tolerance_pct: 1.0,
    tolerance_abs: 5.0,
    severity: { warning: 1.0, serious: 5.0, critical: 10.0 },
    report_overcut: false,
    overcut_min_pct: 15.0
  },
  notifications: {
    enabled: true,
    min_severity: 'warning',
    silent_when_clean: true,
    send_daily_summary: true
  },
  whatsapp: {
    instance_token: null,
    instance_name: null,
    connected_number: null
  },
  // Geracao automatica de periodos, toda terca (ver jobs/autoTargets.js)
  auto_targets: {
    enabled: true,
    adults: 2
  }
}

function deepMerge (base, override) {
  if (override === null || override === undefined) return base
  if (typeof base !== 'object' || Array.isArray(base)) return override
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v
  }
  return out
}

export async function getSettings () {
  const { rows } = await query('SELECT key, value FROM settings')
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const out = {}
  for (const [key, def] of Object.entries(DEFAULTS)) {
    out[key] = deepMerge(def, stored[key])
  }
  return out
}

export async function getSetting (key) {
  const all = await getSettings()
  return all[key]
}

/** Grava mesclando com o que ja existe: um PATCH parcial nunca zera o resto. */
export async function updateSetting (key, patch) {
  if (!(key in DEFAULTS)) throw new Error(`Chave de configuracao desconhecida: ${key}`)
  const current = await getSetting(key)
  const merged = deepMerge(current, patch)
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(merged)]
  )
  return merged
}
