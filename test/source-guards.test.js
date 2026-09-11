import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Regressoes que vivem em SQL ou no DOM do navegador: sem banco/browser aqui, o
// guard e sobre o CODIGO-FONTE. Cada assert amarra o commit que corrigiu o bug.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('#7 expiracao de alvo: usa `<` e NAO `<=` (check-in no proprio dia e valido)', () => {
  const scanner = read('../src/services/scanner.js')
  assert.match(scanner, /check_in\s*<\s*CURRENT_DATE/, 'expira so o que ja passou')
  assert.doesNotMatch(scanner, /check_in\s*<=\s*CURRENT_DATE/, 'o <= matava o alvo criado para hoje')
})

test('#7 autoTargets: bootstrap conta alvos futuros com `> CURRENT_DATE`', () => {
  const auto = read('../src/jobs/autoTargets.js')
  assert.match(auto, /check_in\s*>\s*CURRENT_DATE/)
})

test('#5 grafico: clearChart limpa o skeleton ANTES do prepend (linha e barra)', () => {
  const charts = read('../public/js/charts.js')
  // clearChart preserva so o tooltip e remove o resto (skeleton + svg anterior)
  assert.match(charts, /classList\.contains\('tooltip'\)/)
  assert.match(charts, /child\.remove\(\)/)
  // Nos DOIS graficos o clearChart(host) precede host.prepend(svg)
  const pares = charts.match(/clearChart\(host\)\s*[\r\n]+\s*host\.prepend\(/g) || []
  assert.equal(pares.length, 2, 'lineChart e barChart limpam antes de inserir o SVG')
})

test('#9 Lucide: createIcons fica FUNILADO em refreshIcons (com try/catch)', () => {
  const ui = read('../public/js/ui.js')
  const app = read('../public/js/app.js')
  const charts = read('../public/js/charts.js')

  assert.match(ui, /export function refreshIcons/)
  assert.match(ui, /createIcons/) // a unica chamada legitima
  assert.match(ui, /try\s*\{[\s\S]*createIcons[\s\S]*\}\s*catch/, 'protegido contra CDN offline')

  // O bug historico foi um `lucide.createIcons()` cravado no meio de uma
  // expressao em app.js. Fora do funil de ui.js, ninguem chama createIcons.
  assert.doesNotMatch(app, /createIcons/, 'app.js so usa refreshIcons, nunca createIcons cru')
  assert.doesNotMatch(charts, /createIcons/, 'charts.js so usa refreshIcons')
  assert.match(app, /refreshIcons/)
})
