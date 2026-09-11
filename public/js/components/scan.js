import { api } from '../api.js'

/** Acompanha a varredura em segundo plano ate ela sair de 'running'. */
export async function waitForScan ({ timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const [scan] = await api.scans(1).catch(() => [])
    if (scan && scan.status !== 'running') return scan
  }
  return null
}
