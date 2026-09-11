import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, basename } from 'node:path'

// Regressoes que vivem em SQL ou no DOM do navegador: sem banco/browser aqui, o
// guard e sobre o CODIGO-FONTE. Cada assert amarra o commit que corrigiu o bug.
// Robusto ao refactor: nao depende de contagem fixa de graficos nem de um front
// monolitico (o front foi modularizado em public/js/{components,core,theme}).
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const publicJsDir = fileURLToPath(new URL('../public/js', import.meta.url))
function jsFiles (dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...jsFiles(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

test('#7 expiracao de alvo: usa `<` e NAO `<=` (check-in no proprio dia e valido)', () => {
  const scanner = read('../src/services/scanner.js')
  assert.match(scanner, /check_in\s*<\s*CURRENT_DATE/, 'expira so o que ja passou')
  assert.doesNotMatch(scanner, /check_in\s*<=\s*CURRENT_DATE/, 'o <= matava o alvo criado para hoje')
})

test('#7 autoTargets: bootstrap conta alvos futuros com `> CURRENT_DATE`', () => {
  const auto = read('../src/jobs/autoTargets.js')
  assert.match(auto, /check_in\s*>\s*CURRENT_DATE/)
})

test('#5 grafico: TODO host.prepend(svg) e precedido por clearChart(host) (N graficos)', () => {
  const charts = read('../public/js/charts.js')
  // clearChart preserva so o tooltip e remove o resto (skeleton + svg anterior)
  assert.match(charts, /classList\.contains\('tooltip'\)/)
  assert.match(charts, /child\.remove\(\)/)
  // Robusto a quantos graficos existirem: cada prepend precisa de um clearChart
  // logo antes (a nova lib tem 3 graficos: linha, barra, ...).
  const parts = charts.split('host.prepend(')
  const prepends = parts.length - 1
  assert.ok(prepends >= 2, `esperava >=2 graficos com prepend, achei ${prepends}`)
  for (let i = 0; i < prepends; i++) {
    assert.match(parts[i].slice(-200), /clearChart\(host\)/,
      `host.prepend(svg) #${i + 1} sem clearChart(host) imediatamente antes (skeleton ficaria embaixo)`)
  }
})

test('scanner ↔ registry: o scanner resolve o conector pelo vertical e chama discover/fetchOffers (nao importa a fonte direto)', () => {
  const scanner = read('../src/services/scanner.js')
  // Wiring da integracao: o scanner fala com o registry, nao com o SerpAPI cru.
  assert.match(scanner, /connectorForVertical\s*\(/, 'scanner pede o conector ao registry')
  assert.match(scanner, /\.discover\s*\(/, 'scanner chama connector.discover')
  assert.match(scanner, /\.fetchOffers\s*\(/, 'scanner chama connector.fetchOffers')
  // (o e2e completo do runScan e integracao ⏸ DB; aqui garanto que a costura existe)
})

test('#9 Lucide: createIcons fica FUNILADO em ui.js/refreshIcons (varre todos os modulos do front)', () => {
  const ui = read('../public/js/ui.js')
  assert.match(ui, /export function refreshIcons/)
  assert.match(ui, /try\s*\{[\s\S]*createIcons[\s\S]*\}\s*catch/, 'createIcons protegido contra CDN offline')

  // Fora do funil de ui.js, NENHUM modulo do front chama createIcons cru (o bug
  // historico foi um lucide.createIcons() cravado no meio de uma expressao).
  const offenders = jsFiles(publicJsDir)
    .filter((f) => basename(f) !== 'ui.js' && /createIcons/.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(publicJsDir, 'public/js'))
  assert.deepEqual(offenders, [], `createIcons cru fora de ui.js em: ${offenders.join(', ')}`)

  // E o funil e realmente usado (refreshIcons chamado em algum modulo do front).
  const usesRefresh = jsFiles(publicJsDir).some((f) =>
    basename(f) !== 'ui.js' && /refreshIcons\s*\(/.test(readFileSync(f, 'utf8')))
  assert.ok(usesRefresh, 'refreshIcons deve ser chamado apos innerHTML em algum modulo')
})
