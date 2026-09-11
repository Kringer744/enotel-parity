import { api } from '../api.js'
import { fmtDate, escapeHtml, toast, busy, loading, refreshIcons } from '../ui.js'
import { money2 } from '../charts.js'
import { TODAY } from '../core/state.js'

/* ═══ Configurações ═══════════════════════════════════════════════════════ */

async function pageSettings (main) {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Configurações</h1>
        <p class="page-sub">Regras de paridade, períodos monitorados e consultas de preço</p>
      </div>
    </div>
    <div id="settings-body">${loading('Carregando configurações...', 420)}</div>`

  const [s, props, budget, auto] = await Promise.all([
    api.settings(), api.properties(), api.budget(), api.autoPreview()
  ])
  const p = s.parity
  const n = s.notifications

  document.getElementById('settings-body').innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div>
          <div class="card-title">Diagnóstico da coleta</div>
          <div class="card-note">Confere a conexão, o saldo e a última atualização</div>
        </div>
        <div class="row" style="gap:8px">
          <button class="btn secondary" id="diag-run">Verificar</button>
          <button class="btn secondary" id="diag-live">Testar busca real</button>
        </div>
      </div>
      <div id="diag-out" class="muted small">
        A verificação básica é gratuita. "Testar busca real" usa 1 consulta
        e mostra exatamente quais sites de venda apareceram.
      </div>
    </div>

    <div class="grid two">
      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">Regras de paridade</div>
          <div class="card-note">Comparadas com o seu preço oficial</div>
        </div></div>
        <div class="field">
          <label>Tolerância percentual — abaixo disso nada é reportado</label>
          <input class="input" type="number" step="0.1" id="tol-pct" value="${p.tolerance_pct}">
        </div>
        <div class="field">
          <label>Tolerância absoluta (R$ por diária)</label>
          <input class="input" type="number" step="0.5" id="tol-abs" value="${p.tolerance_abs}">
        </div>
        <div class="divider"></div>
        <div class="card-note" style="margin-bottom:10px">Faixas de severidade (% abaixo do seu preço)</div>
        <div class="row wrap" style="gap:10px">
          <div style="flex:1;min-width:100px">
            <label class="small muted">Atenção ≥</label>
            <input class="input" type="number" step="0.5" id="sev-w" value="${p.severity.warning}">
          </div>
          <div style="flex:1;min-width:100px">
            <label class="small muted">Grave ≥</label>
            <input class="input" type="number" step="0.5" id="sev-s" value="${p.severity.serious}">
          </div>
          <div style="flex:1;min-width:100px">
            <label class="small muted">Crítico ≥</label>
            <input class="input" type="number" step="0.5" id="sev-c" value="${p.severity.critical}">
          </div>
        </div>
        <div class="divider"></div>
        <div class="row between">
          <div>
            <div class="strong">Avisar quando um canal fica acima do seu preço</div>
            <div class="muted small">Não fere contrato, mas indica perda de conversão</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="overcut" ${p.report_overcut ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>
        <button class="btn" id="save-parity" style="margin-top:18px">Salvar regras</button>
      </div>

      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">Notificações</div>
          <div class="card-note">Quando disparar o WhatsApp</div>
        </div></div>
        <div class="row between" style="margin-bottom:16px">
          <div><div class="strong">Alertas ativos</div>
            <div class="muted small">Desligue para pausar todos os envios</div></div>
          <label class="switch">
            <input type="checkbox" id="n-enabled" ${n.enabled ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>
        <div class="field">
          <label>Severidade mínima para notificar</label>
          <select class="select" id="n-sev">
            ${[['info', 'Tudo, inclusive info'], ['warning', 'Atenção ou mais grave'],
               ['serious', 'Apenas grave e crítico'], ['critical', 'Somente crítico']]
              .map(([v, l]) => `<option value="${v}" ${n.min_severity === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="row between">
          <div><div class="strong">Silenciar quando não há violação</div>
            <div class="muted small">Evita mensagem diária sem novidade</div></div>
          <label class="switch">
            <input type="checkbox" id="n-silent" ${n.silent_when_clean ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>
        <button class="btn" id="save-notif" style="margin-top:18px">Salvar notificações</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div>
          <div class="card-title">Períodos monitorados e consultas de preço</div>
          <div class="card-note">Cada período ativo usa 1 consulta por atualização</div>
        </div>
        <div class="badge ${budget.willExceed ? 'critical' : 'good'}">
          <i data-lucide="${budget.willExceed ? 'ban' : 'check'}" class="icon-sm"></i>
          projeção ${budget.projected}/${budget.limit}
        </div>
      </div>
      <div class="grid kpi" style="margin-bottom:18px">
        <div class="stat"><div class="stat-label">Usadas neste mês</div>
          <div class="stat-value">${budget.used}</div>
          <div class="stat-meta">de ${budget.limit} disponíveis</div>
          <div class="meter ${budget.pctUsed >= 90 ? 'is-critical' : budget.pctUsed >= 70 ? 'is-warning' : ''}">
            <span style="width:${Math.min(100, budget.pctUsed)}%"></span></div>
        </div>
        <div class="stat"><div class="stat-label">Por atualização</div>
          <div class="stat-value">${budget.perScan}</div>
          <div class="stat-meta">períodos ativos hoje</div></div>
        <div class="stat"><div class="stat-label">Reserva manual</div>
          <div class="stat-value">${budget.reserve}</div>
          <div class="stat-meta">só disparos manuais podem usar</div></div>
        <div class="stat"><div class="stat-label">Limite saudável</div>
          <div class="stat-value">${budget.maxTargetsPerScan}</div>
          <div class="stat-meta">períodos por atualização até o fim do mês</div></div>
      </div>
      ${props.map((prop) => `
        <div class="strong" style="margin-bottom:8px">${escapeHtml(prop.name)}
          <span class="muted small">· ${escapeHtml(prop.city || '')}</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Período</th><th>Tipo</th><th>Datas</th><th class="num">Noites</th>
              <th class="num">Hóspedes</th><th>Ativo</th><th></th></tr></thead>
            <tbody>
              ${prop.targets.map((t) => `
                <tr>
                  <td class="strong">${escapeHtml(t.label)}</td>
                  <td>${t.mode === 'fixed'
                    ? `<span class="badge info"><i data-lucide="calendar-check" class="icon-sm"></i>Data certa</span>${
                        t.auto_key
                          ? ' <span class="badge neutral"><i data-lucide="sparkles" class="icon-sm"></i>auto</span>'
                          : ''}`
                    : '<span class="badge neutral"><i data-lucide="repeat" class="icon-sm"></i>Sempre à frente</span>'}</td>
                  <td class="mono">${t.mode === 'fixed'
                    ? `${fmtDate(t.check_in)} <span class="muted">→</span> ${fmtDate(t.check_out)}`
                    : `hoje +${t.horizon_days} dias`}</td>
                  <td class="num mono">${t.los}</td>
                  <td class="num mono">${t.adults}</td>
                  <td><label class="switch">
                    <input type="checkbox" data-target="${t.id}" ${t.active ? 'checked' : ''}>
                    <span class="track"></span></label></td>
                  <td><button class="btn ghost small" data-deltarget="${t.id}">Remover</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>

        <div class="divider"></div>
        <div class="row between" style="margin-bottom:10px">
          <div>
            <div class="strong">Períodos automáticos</div>
            <div class="muted small">
              Toda terça o sistema cria o fim de semana e o meio de semana seguinte
            </div>
          </div>
          <label class="switch">
            <input type="checkbox" id="auto-enabled" ${auto.enabled ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>
        <div class="auto-periods">
          ${auto.periods.map((p) => `
            <div class="auto-period">
              <i data-lucide="${p.key === 'weekend' ? 'sun' : 'briefcase'}" class="icon-sm"></i>
              <div>
                <div class="strong small">${p.key === 'weekend' ? 'Fim de semana' : 'Meio de semana'}</div>
                <div class="muted small mono">${fmtDate(p.checkIn)} → ${fmtDate(p.checkOut)}</div>
              </div>
            </div>`).join('')}
          <button class="btn secondary small" id="auto-gen">Gerar agora</button>
        </div>

        <div class="divider"></div>
        <div class="row between" style="margin-bottom:12px">
          <div class="strong">Adicionar período manual</div>
          <div class="segmented" id="t-mode">
            <button data-mode="fixed" class="active">Data certa</button>
            <button data-mode="rolling">Sempre à frente</button>
          </div>
        </div>

        <div id="t-form-fixed" class="date-picker">
          <div class="date-field">
            <label><i data-lucide="calendar" class="icon-sm"></i>Entrada</label>
            <input class="input" type="date" id="t-checkin" min="${TODAY}">
          </div>
          <div class="date-field">
            <label><i data-lucide="calendar" class="icon-sm"></i>Saída</label>
            <input class="input" type="date" id="t-checkout" min="${TODAY}">
          </div>
          <div class="date-field" style="max-width:140px">
            <label><i data-lucide="users" class="icon-sm"></i>Hóspedes</label>
            <select class="select" id="t-adults">
              ${[1, 2, 3, 4, 5, 6].map((n) =>
                `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
          <div class="date-field" style="flex:2">
            <label>Nome (opcional)</label>
            <input class="input" id="t-label" placeholder="Ex.: Réveillon 2027">
          </div>
          <button class="btn" id="t-add" data-prop="${prop.id}">Adicionar</button>
        </div>

        <div id="t-form-rolling" class="date-picker" hidden>
          <div class="date-field" style="flex:2">
            <label>Nome</label>
            <input class="input" id="t-rlabel" placeholder="Ex.: Próximos 90 dias">
          </div>
          <div class="date-field" style="max-width:130px">
            <label>Daqui a (dias)</label>
            <input class="input" type="number" id="t-horizon" min="1" placeholder="90">
          </div>
          <div class="date-field" style="max-width:120px">
            <label>Noites</label>
            <input class="input" type="number" id="t-los" value="2" min="1">
          </div>
          <div class="date-field" style="max-width:130px">
            <label>Hóspedes</label>
            <select class="select" id="t-radults">
              ${[1, 2, 3, 4, 5, 6].map((n) =>
                `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
          <button class="btn" id="t-radd" data-prop="${prop.id}">Adicionar</button>
        </div>

        <p class="muted small" id="t-hint" style="margin-top:10px">
          Cada período ativo usa 1 consulta por atualização.
          Cabem até
          <span class="strong">${budget.maxTargetsPerScan}</span> períodos por atualização este mês.
        </p>`).join('')}
    </div>`

  const renderDiag = (d) => {
    const out = document.getElementById('diag-out')
    out.innerHTML = `
      <div class="stack" style="gap:8px">
        ${d.steps.map((s) => `
          <div class="row" style="gap:10px;align-items:flex-start">
            <span class="badge ${s.ok ? 'good' : 'critical'}" style="min-width:74px;justify-content:center">
              <i data-lucide="${s.ok ? 'check' : 'x'}" class="icon-sm"></i>${s.ok ? 'OK' : 'Falha'}
            </span>
            <div>
              <div class="strong" style="color:var(--ink)">${escapeHtml(s.step)}</div>
              <div class="muted small">${escapeHtml(s.detail || '')}</div>
            </div>
          </div>`).join('')}
      </div>
      ${d.probe ? `
        <div class="divider"></div>
        <div class="strong" style="color:var(--ink);margin-bottom:8px">
          Sites de venda que apareceram
          <span class="muted small">· ${escapeHtml(d.probe.propertyName || d.probe.query)}
          · entrada ${fmtDate(d.probe.checkIn)}</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Site</th><th class="num">Diária</th><th>Canal monitorado</th></tr></thead>
          <tbody>${d.probe.offers.map((o) => `
            <tr>
              <td class="mono">${escapeHtml(o.source)}</td>
              <td class="num mono">${money2(o.price)}</td>
              <td>${o.ignored
                ? '<span class="badge neutral">ignorado</span>'
                : `<span class="badge good">${escapeHtml(o.matchedChannel)}</span>`}</td>
            </tr>`).join('')}</tbody>
        </table></div>
        ${d.probe.offers.every((o) => o.ignored)
          ? '<div class="badge critical" style="margin-top:12px">Nenhum site casou com os canais cadastrados — os padrões de nome precisam de ajuste</div>'
          : ''}` : ''}`
    refreshIcons(out)
  }

  document.getElementById('diag-run').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Verificando…')
    try { renderDiag(await api.diagnose(false)) } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.getElementById('diag-live').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Consultando…')
    try { renderDiag(await api.diagnose(true)) } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.getElementById('save-parity').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Salvando…')
    try {
      await api.updateSettings('parity', {
        tolerance_pct: Number(document.getElementById('tol-pct').value),
        tolerance_abs: Number(document.getElementById('tol-abs').value),
        report_overcut: document.getElementById('overcut').checked,
        severity: {
          warning: Number(document.getElementById('sev-w').value),
          serious: Number(document.getElementById('sev-s').value),
          critical: Number(document.getElementById('sev-c').value)
        }
      })
      toast('Regras de paridade salvas', 'ok')
    } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.getElementById('save-notif').addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Salvando…')
    try {
      await api.updateSettings('notifications', {
        enabled: document.getElementById('n-enabled').checked,
        min_severity: document.getElementById('n-sev').value,
        silent_when_clean: document.getElementById('n-silent').checked
      })
      toast('Preferências de notificação salvas', 'ok')
    } catch (err) { toast(err.message, 'error') }
    busy(ev.currentTarget, false)
  })

  document.querySelectorAll('[data-target]').forEach((sw) =>
    sw.addEventListener('change', async () => {
      try {
        await api.toggleTarget(sw.dataset.target, sw.checked)
        toast('Período atualizado — o consumo muda a partir da próxima atualização', 'ok')
      } catch (err) { toast(err.message, 'error') }
    }))

  document.querySelectorAll('[data-deltarget]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await api.deleteTarget(b.dataset.deltarget); pageSettings(main) } catch (err) { toast(err.message, 'error') }
    }))

  document.getElementById('t-add')?.addEventListener('click', async (ev) => {
    const checkIn = document.getElementById('t-checkin').value
    const checkOut = document.getElementById('t-checkout').value
    if (!checkIn || !checkOut) return toast('Escolha as datas de entrada e saída', 'error')
    if (checkOut <= checkIn) return toast('A saída precisa ser depois da entrada', 'error')

    busy(ev.currentTarget, true, '...')
    try {
      await api.createTarget({
        property_id: Number(ev.currentTarget.dataset.prop),
        mode: 'fixed',
        check_in: checkIn,
        check_out: checkOut,
        adults: Number(document.getElementById('t-adults').value),
        label: document.getElementById('t-label').value.trim()
      })
      toast('Período adicionado', 'ok')
      pageSettings(main)
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })

  document.getElementById('t-radd')?.addEventListener('click', async (ev) => {
    const horizon = Number(document.getElementById('t-horizon').value)
    if (!horizon || horizon < 1) return toast('Informe o número de dias', 'error')

    busy(ev.currentTarget, true, '...')
    try {
      await api.createTarget({
        property_id: Number(ev.currentTarget.dataset.prop),
        mode: 'rolling',
        horizon_days: horizon,
        los: Number(document.getElementById('t-los').value) || 2,
        adults: Number(document.getElementById('t-radults').value),
        label: document.getElementById('t-rlabel').value.trim()
      })
      toast('Período adicionado', 'ok')
      pageSettings(main)
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })

  document.getElementById('auto-enabled')?.addEventListener('change', async (ev) => {
    try {
      await api.updateSettings('auto_targets', { enabled: ev.target.checked })
      toast(ev.target.checked
        ? 'Períodos automáticos ativados'
        : 'Períodos automáticos desativados — os já criados continuam ativos', 'ok')
    } catch (err) { toast(err.message, 'error'); ev.target.checked = !ev.target.checked }
  })

  document.getElementById('auto-gen')?.addEventListener('click', async (ev) => {
    busy(ev.currentTarget, true, 'Gerando...')
    try {
      const r = await api.autoGenerate()
      toast(r.generated.length > 0
        ? `${r.generated.length} período(s) criado(s)`
        : 'Os períodos desta semana já existem', r.generated.length > 0 ? 'ok' : 'info')
      pageSettings(main)
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })

  // Alterna entre os dois formulários de cadastro.
  document.getElementById('t-mode')?.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      const fixed = b.dataset.mode === 'fixed'
      document.getElementById('t-mode').querySelectorAll('button')
        .forEach((x) => x.classList.toggle('active', x === b))
      document.getElementById('t-form-fixed').hidden = !fixed
      document.getElementById('t-form-rolling').hidden = fixed
    }))

  // Check-out sempre depois do check-in: move o piso ao escolher a entrada.
  document.getElementById('t-checkin')?.addEventListener('change', (ev) => {
    const out = document.getElementById('t-checkout')
    const min = new Date(`${ev.target.value}T12:00:00Z`)
    min.setUTCDate(min.getUTCDate() + 1)
    out.min = min.toISOString().slice(0, 10)
    if (!out.value || out.value <= ev.target.value) out.value = out.min
  })
}
