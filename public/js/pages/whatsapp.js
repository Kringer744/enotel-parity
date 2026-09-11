import { api } from '../api.js'
import { fmtDateTime, escapeHtml, statusBadge, toast, busy, loading, emptyState, refreshIcons } from '../ui.js'

/* ═══ WhatsApp ════════════════════════════════════════════════════════════ */

let qrTimer = null

export async function pageWhatsApp (main) {
  clearInterval(qrTimer)

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>WhatsApp</h1>
        <p class="page-sub">Conecte o número e escolha quem recebe os avisos de paridade</p>
      </div>
    </div>
    <div class="grid two">
      <div class="card"><div id="wa-conn">${loading('Verificando conexão...', 280)}</div></div>
      <div class="card"><div id="wa-recip">${loading('Carregando destinatários...', 280)}</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div>
        <div class="card-title">Prévia da mensagem</div>
        <div class="card-note">Exemplo do alerta que chega no aparelho</div>
      </div></div>
      <div class="wa-preview">
        <div class="wa-bubble"><b>ALERTA DE PARIDADE — Enotel BR</b> [CRITICO]

<b>Enotel Porto de Galinhas</b>
Atualização de 31/08/2026 06:10
<b>2</b> violações encontradas

<b>[CRITICO] Booking.com</b>
   Entrada 30/09 · 2 noites
   Seu preço: R$ 1.240,00  →  Canal: R$ 1.078,00
   Diferença: -13,1% (R$ 162,00/noite)

<b>[ATENCAO] Trip.com</b>
   Entrada 30/10 · 2 noites
   Seu preço: R$ 1.180,00  →  Canal: R$ 1.145,00
   Diferença: -3,0% (R$ 35,00/noite)

<i>Consultas de preço: 87/250 este mês</i></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="card-title">Envios recentes</div></div>
      <div id="wa-log">${loading('Carregando envios...', 140)}</div>
    </div>`

  await renderWaConnection()
  await renderWaRecipients()
  await renderWaLog()
}

async function renderWaConnection () {
  const host = document.getElementById('wa-conn')
  if (!host) return

  let status
  try {
    status = await api.waStatus()
  } catch (err) {
    host.innerHTML = emptyState('info', err.message)
    refreshIcons(host)
    return
  }

  if (!status.configured) {
    host.innerHTML = `
      <div class="card-head"><div class="card-title">Conexão</div></div>
      ${emptyState('message-circle', 'Os avisos por WhatsApp ainda não estão disponíveis nesta conta. Em breve dá pra conectar o seu número por aqui.')}`
    refreshIcons(host)
    return
  }

  if (status.connected) {
    host.innerHTML = `
      <div class="card-head">
        <div class="card-title">Conexão</div>
        <span class="badge good"><i data-lucide="check" class="icon-sm"></i>Conectado</span>
      </div>
      <div class="row" style="gap:14px;margin-bottom:18px">
        <div class="avatar" style="width:48px;height:48px">
          <i data-lucide="message-circle" class="icon-lg"></i>
        </div>
        <div>
          <div class="strong">${escapeHtml(status.profileName || 'WhatsApp conectado')}</div>
          <div class="muted small mono">${escapeHtml(status.number || '')}</div>
        </div>
      </div>
      <div class="row wrap">
        <button class="btn secondary" id="wa-refresh-contacts">Carregar contatos</button>
        <button class="btn secondary danger" id="wa-disconnect">Desconectar</button>
      </div>
      <div id="contacts" style="margin-top:16px"></div>`

    document.getElementById('wa-disconnect').addEventListener('click', async (ev) => {
      busy(ev.currentTarget, true, 'Desconectando…')
      try { await api.waDisconnect(); toast('Desconectado', 'ok'); await renderWaConnection() } catch (err) { toast(err.message, 'error') }
    })
    document.getElementById('wa-refresh-contacts').addEventListener('click', loadContacts)
    refreshIcons(host)
    return
  }

  host.innerHTML = `
    <div class="card-head">
      <div class="card-title">Conexão</div>
      <span class="badge warning"><i data-lucide="zap" class="icon-sm"></i>${status.instance ? 'Desconectado' : 'Não conectado'}</span>
    </div>
    <p class="muted small" style="margin-bottom:16px">
      ${status.instance
        ? 'Gere o QR code e leia com o WhatsApp do celular em Aparelhos conectados.'
        : 'Vamos conectar o seu WhatsApp para começar.'}
    </p>
    <div id="qr-area"></div>
    <button class="btn block" id="wa-action" style="margin-top:14px">
      ${status.instance ? 'Gerar QR code' : 'Conectar WhatsApp'}
    </button>`

  refreshIcons(host)
  document.getElementById('wa-action').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget
    busy(btn, true, 'Aguarde…')
    try {
      if (!status.instance) {
        await api.waInit('enotel-paridade')
        toast('Conexão iniciada', 'ok')
        return renderWaConnection()
      }
      const conn = await api.waConnect()
      const area = document.getElementById('qr-area')
      if (conn.qrcode) {
        area.innerHTML = `
          <div class="qr-frame"><img src="${conn.qrcode}" alt="QR code de pareamento"></div>
          <p class="muted small" style="text-align:center;margin-top:12px">
            O código expira em cerca de 40 segundos e é renovado automaticamente.
          </p>`
        // Sonda a conexão: assim que o pareamento conclui, a tela troca sozinha.
        clearInterval(qrTimer)
        qrTimer = setInterval(async () => {
          const s = await api.waStatus().catch(() => null)
          if (s?.connected) {
            clearInterval(qrTimer)
            toast('WhatsApp conectado', 'ok')
            renderWaConnection()
          }
        }, 4000)
      } else if (conn.paircode) {
        area.innerHTML = `<div class="empty"><i data-lucide="hash" class="empty-icon"></i>
          Código de pareamento: <span class="strong mono" style="font-size:20px">${escapeHtml(conn.paircode)}</span></div>`
        refreshIcons(area)
      } else {
        area.innerHTML = emptyState('info', 'Não consegui gerar o QR code agora. Tente de novo em instantes.')
        refreshIcons(area)
      }
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      busy(btn, false)
    }
  })
}

async function loadContacts () {
  const host = document.getElementById('contacts')
  if (!host) return
  host.innerHTML = loading('Buscando contatos do WhatsApp...', 200)
  try {
    const contacts = await api.waContacts()
    if (contacts.length === 0) {
      host.innerHTML = emptyState('info', 'Nenhuma conversa encontrada. Envie uma mensagem pelo celular e recarregue.')
      refreshIcons(host)
      return
    }
    host.innerHTML = `
      <div class="field" style="margin-bottom:10px">
        <input class="input" id="c-search" placeholder="Buscar contato ou grupo…">
      </div>
      <div class="contact-list" id="c-list"></div>`

    const draw = (term = '') => {
      const filtered = contacts.filter((c) =>
        !term || c.name.toLowerCase().includes(term.toLowerCase()) || (c.phone || '').includes(term))
      document.getElementById('c-list').innerHTML = filtered.slice(0, 100).map((c) => `
        <div class="contact-row" data-jid="${escapeHtml(c.jid)}"
             data-name="${escapeHtml(c.name)}" data-phone="${escapeHtml(c.phone || '')}"
             data-group="${c.isGroup}">
          <div class="avatar">${c.image ? `<img src="${escapeHtml(c.image)}" alt="">` : (c.isGroup ? '<i data-lucide="users" class="icon-sm"></i>' : escapeHtml(c.name.charAt(0).toUpperCase()))}</div>
          <div>
            <div class="contact-name">${escapeHtml(c.name)}</div>
            <div class="contact-meta">${c.isGroup ? 'Grupo' : escapeHtml(c.phone || '')}</div>
          </div>
          <button class="btn small" style="margin-left:auto">Selecionar</button>
        </div>`).join('')

      refreshIcons(document.getElementById('c-list'))
      document.getElementById('c-list').querySelectorAll('.contact-row').forEach((row) =>
        row.addEventListener('click', async () => {
          try {
            await api.waAddRecipient({
              name: row.dataset.name,
              phone: row.dataset.phone,
              jid: row.dataset.jid,
              is_group: row.dataset.group === 'true'
            })
            toast(`${row.dataset.name} receberá os alertas`, 'ok')
            await renderWaRecipients()
          } catch (err) { toast(err.message, 'error') }
        }))
    }

    draw()
    document.getElementById('c-search').addEventListener('input', (ev) => draw(ev.target.value))
  } catch (err) {
    host.innerHTML = emptyState('info', err.message)
  }
}

async function renderWaRecipients () {
  const host = document.getElementById('wa-recip')
  if (!host) return
  const list = await api.waRecipients().catch(() => [])

  host.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-title">Destinatários dos alertas</div>
        <div class="card-note">Quem recebe os avisos de paridade</div>
      </div>
    </div>
    ${list.length === 0
      ? emptyState('info', 'Nenhum destinatário. Conecte o WhatsApp e selecione um contato, ou adicione um número abaixo.')
      : `<div class="contact-list" style="margin-bottom:16px">
          ${list.map((r) => `
            <div class="contact-row">
              <div class="avatar">${r.is_group ? '<i data-lucide="users" class="icon-sm"></i>' : escapeHtml(r.name.charAt(0).toUpperCase())}</div>
              <div>
                <div class="contact-name">${escapeHtml(r.name)}</div>
                <div class="contact-meta">${escapeHtml(r.phone)}</div>
              </div>
              <div class="row" style="margin-left:auto;gap:8px">
                <button class="btn ghost small" data-test="${escapeHtml(r.jid || r.phone)}">Testar</button>
                <label class="switch">
                  <input type="checkbox" data-toggle="${r.id}" ${r.active ? 'checked' : ''}>
                  <span class="track"></span>
                </label>
                <button class="btn ghost small" data-del="${r.id}" title="Remover">
                  <i data-lucide="x" class="icon-sm"></i>
                </button>
              </div>
            </div>`).join('')}
        </div>`}
    <div class="divider"></div>
    <div class="card-note" style="margin-bottom:10px">Adicionar número manualmente</div>
    <div class="row wrap" style="gap:8px">
      <input class="input" id="m-name" placeholder="Nome" style="flex:1;min-width:130px">
      <input class="input" id="m-phone" placeholder="5581999998888" style="flex:1;min-width:150px">
      <button class="btn" id="m-add">Adicionar</button>
    </div>`

  refreshIcons(host)
  host.querySelectorAll('[data-toggle]').forEach((sw) =>
    sw.addEventListener('change', async () => {
      try { await api.waToggleRecipient(sw.dataset.toggle, sw.checked) } catch (err) { toast(err.message, 'error') }
    }))

  host.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await api.waRemoveRecipient(b.dataset.del); await renderWaRecipients() } catch (err) { toast(err.message, 'error') }
    }))

  host.querySelectorAll('[data-test]').forEach((b) =>
    b.addEventListener('click', async () => {
      busy(b, true, '…')
      try { await api.waTest(b.dataset.test); toast('Mensagem de teste enviada', 'ok') } catch (err) { toast(err.message, 'error') }
      busy(b, false)
    }))

  document.getElementById('m-add').addEventListener('click', async (ev) => {
    const name = document.getElementById('m-name').value.trim()
    const phone = document.getElementById('m-phone').value.trim()
    if (!name || !phone) return toast('Informe nome e telefone', 'error')
    busy(ev.currentTarget, true, '…')
    try {
      await api.waAddRecipient({ name, phone })
      toast('Destinatário adicionado', 'ok')
      await renderWaRecipients()
    } catch (err) { toast(err.message, 'error'); busy(ev.currentTarget, false) }
  })
}

async function renderWaLog () {
  const host = document.getElementById('wa-log')
  if (!host) return
  const log = await api.waNotifications().catch(() => [])
  host.innerHTML = log.length === 0
    ? emptyState('info', 'Nenhum alerta enviado ainda.')
    : `<div class="table-wrap"><table>
        <thead><tr><th>Quando</th><th>Destinatário</th><th>Status</th><th>Observação</th></tr></thead>
        <tbody>${log.map((n) => `
          <tr>
            <td class="mono small">${fmtDateTime(n.created_at)}</td>
            <td>${escapeHtml(n.recipient_name || n.phone)}</td>
            <td>${statusBadge(n.status)}</td>
            <td class="small muted">${escapeHtml(n.error || '—')}</td>
          </tr>`).join('')}</tbody></table></div>`
  refreshIcons(host)
}
