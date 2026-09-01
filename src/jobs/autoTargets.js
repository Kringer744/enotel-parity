import { query } from '../db/pool.js'
import { getSettings } from '../services/settings.js'

/**
 * Geracao automatica de periodos.
 *
 * Toda terca o sistema cria dois alvos de data fixa por propriedade ativa:
 *   - fim de semana .... sexta -> domingo   (2 noites)
 *   - meio de semana ... terca seguinte -> quinta  (2 noites)
 *
 * Sao os dois blocos que se comportam de forma diferente em resort de praia:
 * o fim de semana enche primeiro e e onde a OTA costuma furar a paridade; o
 * meio de semana e onde sobra estoque e aparece desconto agressivo.
 *
 * Os alvos criados aqui sao 'fixed', entao o scanner os desativa sozinho
 * quando o check-in passa -- nao ha limpeza manual a fazer.
 */

const TUESDAY = 2
const FRIDAY = 5

/** Recife e UTC-3 o ano todo (sem horario de verao), entao o desvio e fixo. */
export function recifeToday (now = new Date()) {
  return new Date(now.getTime() - 3 * 3600 * 1000)
}

function addDays (d, n) {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + n)
  return x
}

const iso = (d) => d.toISOString().slice(0, 10)

/** Proximo dia da semana, estritamente no futuro. */
function nextWeekday (from, weekday) {
  let delta = (weekday - from.getUTCDay() + 7) % 7
  if (delta === 0) delta = 7
  return addDays(from, delta)
}

const ddmm = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`

/**
 * Calcula os dois periodos a partir de uma data de referencia.
 * A terca do meio de semana e a que vem DEPOIS do fim de semana, para os dois
 * blocos nunca se sobreporem.
 */
export function computeAutoPeriods (today = recifeToday()) {
  const friday = nextWeekday(today, FRIDAY)
  const sunday = addDays(friday, 2)
  const tuesday = nextWeekday(friday, TUESDAY)
  const thursday = addDays(tuesday, 2)

  return [
    {
      key: 'weekend',
      label: `Fim de semana · ${ddmm(friday)} a ${ddmm(sunday)}`,
      checkIn: iso(friday),
      checkOut: iso(sunday)
    },
    {
      key: 'midweek',
      label: `Meio de semana · ${ddmm(tuesday)} a ${ddmm(thursday)}`,
      checkIn: iso(tuesday),
      checkOut: iso(thursday)
    }
  ]
}

/**
 * Cria os periodos da semana se ainda nao existirem.
 *
 * Roda em toda varredura, mas so gera de fato as tercas -- ou quando nenhum
 * alvo automatico existe ainda (primeiro boot), para o sistema ja subir com
 * dados em vez de esperar a proxima terca.
 */
export async function ensureAutoTargets ({ force = false } = {}) {
  const settings = await getSettings()
  const cfg = settings.auto_targets
  if (!cfg.enabled) return { generated: [], skipped: 'desativado' }

  const today = recifeToday()
  const isGenerationDay = today.getUTCDay() === TUESDAY

  const { rows: existing } = await query(
    `SELECT COUNT(*)::int AS n FROM scan_targets
     WHERE auto_key IS NOT NULL AND active AND check_in > CURRENT_DATE`
  )
  const bootstrap = existing[0].n === 0

  if (!force && !isGenerationDay && !bootstrap) {
    return { generated: [], skipped: 'fora do dia de geracao' }
  }

  const { rows: properties } = await query(
    'SELECT id FROM properties WHERE active ORDER BY id'
  )
  const periods = computeAutoPeriods(today)
  const generated = []

  for (const p of properties) {
    for (const period of periods) {
      // O indice unico parcial impede duplicar a mesma estadia; o DO NOTHING
      // deixa a operacao idempotente se a varredura rodar duas vezes no dia.
      const { rows } = await query(
        `INSERT INTO scan_targets
           (property_id, label, mode, check_in, check_out, los, adults, auto_key)
         VALUES ($1, $2, 'fixed', $3, $4, 2, $5, $6)
         ON CONFLICT (property_id, check_in, check_out, adults) WHERE mode = 'fixed'
           DO NOTHING
         RETURNING id, label`,
        [p.id, period.label, period.checkIn, period.checkOut, cfg.adults, period.key]
      )
      if (rows[0]) generated.push(rows[0].label)
    }
  }

  if (generated.length > 0) {
    console.log(`[auto-targets] ${generated.length} periodo(s) criado(s): ${generated.join(' | ')}`)
  }
  return { generated, bootstrap, isGenerationDay }
}
