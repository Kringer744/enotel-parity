import cron from 'node-cron'
import { config } from '../config.js'
import { runScan } from '../services/scanner.js'

let task = null

export function startScheduler () {
  if (!config.scan.schedulerEnabled) {
    console.log('[scheduler] desativado por SCHEDULER_ENABLED')
    return null
  }
  if (!cron.validate(config.scan.cron)) {
    console.error(`[scheduler] SCAN_CRON invalido: "${config.scan.cron}" - agendamento nao iniciado`)
    return null
  }

  task = cron.schedule(config.scan.cron, async () => {
    console.log('[scheduler] iniciando varredura diaria')
    try {
      const result = await runScan({ trigger: 'schedule' })
      if (result.skipped) {
        console.warn(`[scheduler] varredura pulada: ${result.reason}`)
        return
      }
      for (const run of result.runs) {
        if (run.skipped) {
          console.warn(`[scheduler] tenant #${run.tenantId} pulado: ${run.reason}`)
        } else if (run.status === 'failed' && run.error) {
          console.error(`[scheduler] tenant #${run.tenantId} falhou: ${run.error}`)
        } else {
          console.log(
            `[scheduler] tenant #${run.tenantId} varredura #${run.scanId} ${run.status}: ` +
            `${run.rates} tarifas, ${run.findings} achados, ${run.spent} requisicoes`
          )
        }
      }
    } catch (err) {
      console.error('[scheduler] varredura falhou:', err.message)
    }
  }, { timezone: config.scan.timezone })

  console.log(`[scheduler] varredura agendada "${config.scan.cron}" (${config.scan.timezone})`)
  return task
}

export function stopScheduler () {
  if (task) { task.stop(); task = null }
}
