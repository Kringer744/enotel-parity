import { api } from '../api.js'
import { loading } from '../ui.js'
import { state } from '../core/state.js'
import { periodPicker, wirePeriod } from '../components/period.js'
import { findingsTable, wireFindingRows } from '../components/findings-table.js'

/* ═══ Violações ═══════════════════════════════════════════════════════════ */

async function pageFindings (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Violações de paridade</h1>
        <p class="page-sub">Canais vendendo abaixo do seu preço oficial</p>
      </div>
      <div class="row wrap">
        ${periodPicker()}
        <select class="select" id="f-sev" style="width:auto">
          <option value="">Todas as severidades</option>
          <option value="critical">Crítico</option>
          <option value="serious">Grave</option>
          <option value="warning">Atenção</option>
        </select>
        <select class="select" id="f-status" style="width:auto">
          <option value="">Todos os status</option>
          <option value="open">Aberto</option>
          <option value="acknowledged">Ciente</option>
          <option value="resolved">Resolvido</option>
        </select>
      </div>
    </div>
    <div class="card"><div id="list">${loading('Buscando violações...', 300)}</div></div>`

  wirePeriod(() => pageFindings(main))

  const load = async () => {
    const params = { days: state.days, limit: 300 }
    const sev = document.getElementById('f-sev').value
    const st = document.getElementById('f-status').value
    if (sev) params.severity = sev
    if (st) params.status = st
    document.getElementById('list').innerHTML = loading('Buscando violações...', 300)
    const findings = await api.findings(params)
    document.getElementById('list').innerHTML = findingsTable(findings)
    wireFindingRows()
  }

  document.getElementById('f-sev').addEventListener('change', load)
  document.getElementById('f-status').addEventListener('change', load)
  await load()
}
