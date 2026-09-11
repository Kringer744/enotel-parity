/* Modulo de theming (dono: Prisma). Resolve e persiste o modo de tema em tres
   estados -- 'light' | 'dark' | 'system' -- e aplica data-theme no <html>. Os
   tokens CSS (app.css) fazem o resto: como as marcas dos graficos pintam por
   var(--series-N)/var(--seq-*), a troca de tema repinta tudo sem redraw.

   Integracao (territorio do Vitrine):
     import { initTheme, cycleTheme, themeMeta, onThemeChange } from './theme.js'
     initTheme()                       // no boot, antes de montar a casca
     botao.onclick = () => cycleTheme()// no rodape da sidebar
   Anti-flash no <head> do index.html (roda antes do paint):
     <script>try{var m=localStorage.getItem('paridade.theme');
       if(m==='light'||m==='dark')document.documentElement.setAttribute('data-theme',m)}catch(e){}</script> */

const KEY = 'paridade.theme'
const MODES = ['light', 'dark', 'system']
const listeners = new Set()

function stored () {
  try {
    const v = localStorage.getItem(KEY)
    return MODES.includes(v) ? v : 'system'
  } catch { return 'system' }
}

function persist (mode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch { /* modo privado / storage bloqueado: aplica so nesta sessao */ }
}

function apply (mode) {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

function notify () {
  const detail = { mode: stored(), resolved: resolvedTheme() }
  for (const cb of listeners) {
    try { cb(detail) } catch { /* erro no callback do consumidor nao derruba o tema */ }
  }
}

/** O modo escolhido pelo usuario: 'light' | 'dark' | 'system'. */
export function getTheme () { return stored() }

/** O modo efetivo apos resolver 'system' contra o SO: 'light' | 'dark'. */
export function resolvedTheme () {
  const m = stored()
  if (m !== 'system') return m
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch { return 'light' }
}

/** Define o modo, aplica no <html>, persiste e notifica os assinantes. */
export function setTheme (mode) {
  const m = MODES.includes(mode) ? mode : 'system'
  apply(m)
  persist(m)
  notify()
  return m
}

/** Alterna Claro -> Escuro -> Sistema -> Claro. Devolve o novo modo. */
export function cycleTheme () {
  const next = MODES[(MODES.indexOf(stored()) + 1) % MODES.length]
  return setTheme(next)
}

/**
 * Assina mudancas de tema: escolha do usuario OU mudanca do SO enquanto em
 * 'system'. Devolve uma funcao para cancelar a assinatura.
 */
export function onThemeChange (cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let inited = false

/** Aplica o modo salvo e liga o observador do SO. Idempotente. Chame no boot. */
export function initTheme () {
  if (inited) return
  inited = true
  apply(stored())
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onOs = () => { if (stored() === 'system') notify() }
    if (mq.addEventListener) mq.addEventListener('change', onOs)
    else if (mq.addListener) mq.addListener(onOs) // Safari antigo
  } catch { /* matchMedia indisponivel */ }
}

/** Icone Lucide + rotulo do estado atual -- para o Vitrine montar o botao. */
export function themeMeta () {
  return {
    light: { icon: 'sun', label: 'Claro' },
    dark: { icon: 'moon', label: 'Escuro' },
    system: { icon: 'monitor', label: 'Sistema' }
  }[stored()]
}
