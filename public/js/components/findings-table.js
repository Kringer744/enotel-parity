import { api } from '../api.js'
import {
  fmtDateTime, fmtDate, pct, severityBadge, statusBadge,
  escapeHtml, toast, busy, emptyState, KIND
} from '../ui.js'
import { money2 } from '../charts.js'
import { state, navigate } from '../core/state.js'

/* ═══ Tabela de violacoes (compartilhada por Painel, Violacoes e Relatorio) ═ */

export function findingsTable (findings) {
  if (findings.length === 0) {
    return emptyState('info', 'Nenhuma violação de paridade no período. Todos os canais em conformidade.')
  }
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Detectado</th><th>Canal</th><th>Entrada</th><th>Saída</th>
          <th class="num">Seu preço</th><th class="num">Canal</th><th class="num">Diferença</th>
          <th>Severidade</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${findings.map((f) => `
            <tr data-id="${f.id}">
              <td class="muted small">${fmtDateTime(f.created_at)}</td>
              <td>
                <span class="channel-key">
                  <span class="channel-swatch" style="background:${f.channel_color || 'var(--ink-3)'}"></span>
                  ${escapeHtml(f.channel_name || '—')}
                </span>
                <div class="muted small" style="margin-top:2px">${KIND[f.kind] || f.kind}</div>
              </td>
              <td class="mono">${fmtDate(f.check_in)}</td>
              <td class="mono">${fmtDate(f.check_out)}<div class="muted small">${f.los || 2} noites</div></td>
              <td class="num mono">${money2(f.base_price)}</td>
              <td class="num mono strong">${money2(f.channel_price)}</td>
              <td class="num mono" style="color:${f.delta_pct < 0 ? 'var(--critical)' : 'var(--ink-2)'}">
                ${f.delta_pct === null ? '—' : `${f.delta_pct > 0 ? '+' : ''}${pct(f.delta_pct)}`}
                <div class="muted small">${f.delta_abs === null ? '' : money2(Math.abs(f.delta_abs)) + '/noite'}</div>
              </td>
              <td>${severityBadge(f.severity)}</td>
              <td>${statusBadge(f.status)}</td>
              <td>
                ${f.status === 'open'
                  ? `<button class="btn secondary small" data-ack="${f.id}">Marcar ciente</button>`
                  : f.status === 'acknowledged'
                  ? `<button class="btn secondary small" data-resolve="${f.id}">Resolver</button>`
                  : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`
}

export function wireFindingRows () {
  document.querySelectorAll('[data-ack],[data-resolve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.ack || btn.dataset.resolve
      const status = btn.dataset.ack ? 'acknowledged' : 'resolved'
      busy(btn, true, '…')
      try {
        await api.updateFinding(id, status)
        toast('Status atualizado', 'ok')
        navigate(state.page)
      } catch (err) {
        busy(btn, false)
        toast(err.message, 'error')
      }
    })
  })
}
