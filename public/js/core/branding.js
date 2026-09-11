/* White-label por tenant. Aplica a marca (nome, sigla, cor) no boot.
   A cor vem de UMA variável (--brand-accent); --accent e --brand-gradient
   derivam dela no app.css, então trocar o tenant recolore o UI todo.
   As séries dos gráficos NÃO mudam (paleta categórica fica CVD-safe).

   Em produção o tenant vem do backend (api.me()/api/tenant, pendente do Núcleo).
   No demo, window.__TENANTS__ traz Enotel/Fluxo/Acme e o switch chama applyBranding. */

export const DEFAULT_BRAND = {
  id: 'enotel', name: 'Paridade', sub: 'Enotel BR', mark: 'E',
  accent: '#0071e3', title: 'Paridade Enotel'
}

/** Aplica a marca do tenant: cor (via --brand-accent), título, nome/sigla na casca. */
export function applyBranding (tenant) {
  const t = { ...DEFAULT_BRAND, ...(tenant || {}) }
  if (t.accent) document.documentElement.style.setProperty('--brand-accent', t.accent)
  document.title = t.title || `${t.name}${t.sub ? ' ' + t.sub : ''}`.trim()
  const setText = (sel, v) => {
    const el = document.querySelector(sel)
    if (el && v != null) el.textContent = v
  }
  setText('.brand-name', t.name)
  setText('.brand-sub', t.sub)
  setText('.brand-mark', t.mark)
  return t
}
