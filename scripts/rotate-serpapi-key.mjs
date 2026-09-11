#!/usr/bin/env node
/**
 * Rotacao segura da SERPAPI_KEY na env do EasyPanel (servidor 3).
 *
 * POR QUE ESTE SCRIPT: `services.app.updateEnv` SUBSTITUI o bloco de env INTEIRO.
 * Mandar so a linha nova ZERARIA DATABASE_URL, JWT_SECRET, ADMIN_*, etc. Entao o
 * fluxo correto e READ-MODIFY-WRITE: le a env atual (inspectService), troca SO a
 * linha SERPAPI_KEY, verifica que nada mais mudou, e so entao reenvia o bloco.
 *
 * SEGURANCA:
 *   - Default = DRY-RUN. Nunca escreve sem --apply.
 *   - --apply exige a chave nova (NEW_SERPAPI_KEY) E confirma que a verificacao
 *     passou. Se qualquer var fora da SERPAPI_KEY seria alterada, ABORTA.
 *   - Nunca imprime valores de segredo. SERPAPI_KEY sai mascarada (4+4); os demais
 *     valores nunca sao exibidos, so os NOMES das chaves.
 *
 * USO:
 *   node scripts/rotate-serpapi-key.mjs --self-test          # offline, valida a logica (fixture)
 *   EASYPANEL_TOKEN=... node scripts/rotate-serpapi-key.mjs   # DRY-RUN contra a env viva
 *   EASYPANEL_TOKEN=... NEW_SERPAPI_KEY=... node scripts/rotate-serpapi-key.mjs --apply
 *
 * Depois do --apply: confere /health (uptime baixo) e GET /api/serpapi/diagnose.
 */

import assert from 'node:assert/strict'

// Endereco do painel vem SEMPRE do ambiente — nao hardcodar o IP interno do
// Easypanel num repo publico (disclosure de infra). Ver CONTEXTO-ENOTEL §1.
const PANEL = (process.env.EASYPANEL_URL || '').replace(/\/+$/, '')
const TOKEN = process.env.EASYPANEL_TOKEN || ''
const PROJECT = process.env.EASYPANEL_PROJECT || 'proxy'
const SERVICE = process.env.EASYPANEL_SERVICE || 'enotel'
const KEY = 'SERPAPI_KEY'

// ─── transformacao pura (testavel isolada) ──────────────────────────────────

/** Regex de "NOME=valor" de env. Captura o 1o '=' ; o resto (inclusive '=') e valor. */
const ENV_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/**
 * Troca o valor de UMA chave, preservando byte a byte todo o resto (comentarios,
 * linhas em branco, ordem, e o estilo de quebra de linha original).
 * @returns {{ text: string, hits: number }} hits = quantas linhas casaram a chave.
 */
export function replaceEnvValue (envText, key, newValue) {
  const nl = envText.includes('\r\n') ? '\r\n' : '\n'
  let hits = 0
  const out = envText.split(/\r?\n/).map((line) => {
    const m = line.match(ENV_LINE)
    if (m && m[2] === key) { hits++; return `${m[1]}${key}=${newValue}` }
    return line
  })
  return { text: out.join(nl), hits }
}

/** Lista os NOMES das chaves na ordem em que aparecem (linhas NOME=...). */
export function envKeys (envText) {
  const keys = []
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(ENV_LINE)
    if (m) keys.push(m[2])
  }
  return keys
}

/**
 * Garante que a unica diferenca entre `before` e `after` e a linha da `key`.
 * @returns {{ problems: string[], changedLines: number[] }}
 */
export function verifyOnlyKeyChanged (before, after, key) {
  const problems = []
  const kb = envKeys(before)
  const ka = envKeys(after)

  if (kb.length !== ka.length) problems.push(`nº de chaves mudou: ${kb.length} -> ${ka.length}`)
  const setB = new Set(kb)
  const setA = new Set(ka)
  for (const k of setB) if (!setA.has(k)) problems.push(`chave SUMIU: ${k}`)
  for (const k of setA) if (!setB.has(k)) problems.push(`chave nova inesperada: ${k}`)

  const lb = before.split(/\r?\n/)
  const la = after.split(/\r?\n/)
  if (lb.length !== la.length) problems.push(`nº de linhas mudou: ${lb.length} -> ${la.length}`)

  const changedLines = []
  for (let i = 0; i < Math.max(lb.length, la.length); i++) {
    if (lb[i] !== la[i]) changedLines.push(i)
  }
  for (const i of changedLines) {
    const name = (la[i] ?? lb[i] ?? '').match(ENV_LINE)?.[2]
    if (name !== key) problems.push(`linha ${i + 1} mudou fora de ${key} (chave: ${name ?? '??'})`)
  }
  return { problems, changedLines }
}

// ─── util ───────────────────────────────────────────────────────────────────

/** Mascara um segredo: mantem 4 do inicio e 4 do fim. Nunca imprime o meio. */
function mask (v) {
  if (!v) return '(vazio)'
  if (v.length <= 12) return '****'
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`
}

/** Valor da SERPAPI_KEY atual, so pra mascarar no relatorio. */
function currentKeyValue (envText) {
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(ENV_LINE)
    if (m && m[2] === KEY) return m[3]
  }
  return ''
}

/** tRPC do EasyPanel: query = GET ?input=; mutation = POST body {json}. */
async function trpc (procedure, input, { mutation = false } = {}) {
  const url = mutation
    ? `${PANEL}/api/trpc/${procedure}`
    : `${PANEL}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
  const res = await fetch(url, {
    method: mutation ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: mutation ? JSON.stringify({ json: input }) : undefined
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!res.ok) {
    const msg = data?.error?.json?.message || data?.error?.message || `HTTP ${res.status}`
    const err = new Error(`${procedure}: ${msg}`)
    err.status = res.status
    throw err
  }
  return data?.result?.data?.json ?? data
}

async function fetchEnv () {
  const svc = await trpc('services.app.inspectService', { projectName: PROJECT, serviceName: SERVICE })
  const env = svc?.env
  if (typeof env !== 'string') throw new Error('inspectService nao devolveu env como string (shape mudou?)')
  return env
}

// ─── self-test offline (fixture = a env documentada do servidor 3) ──────────

function selfTest () {
  // Fixture: replica o formato/ordem da env real (valores dos segredos sao ficticios).
  const fixture = [
    'NODE_ENV=production',
    'PORT=3000',
    'JWT_SECRET=ZmFrZS1qd3Qtc2VjcmV0LTY0LWNoYXJzLXBhcmEtdGVzdGUtc29tZW50ZS1uYW8tcmVhbA==',
    'ADMIN_EMAIL=admin@enotel.com.br',
    'ADMIN_PASSWORD=Enotel@fakefake',
    'ADMIN_NAME=Administrador Enotel',
    'DATABASE_URL=postgres://postgres:senha-com=e:arroba@proxy_enotel-db:5432/enotel-db?sslmode=disable',
    'PGSSLMODE=disable',
    'SERPAPI_KEY=0000000000000000000000000000000000000000000000000000000000000000',
    'SERPAPI_MONTHLY_LIMIT=250',
    'SERPAPI_RESERVE=25',
    'UAZAPI_URL=',
    'UAZAPI_ADMIN_TOKEN=',
    'UAZAPI_INSTANCE_TOKEN=',
    'SCAN_CRON=10 6 * * *',
    'SCAN_TIMEZONE=America/Recife',
    'SCHEDULER_ENABLED=true'
  ]
  const NEW = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  let pass = 0

  // 1. LF
  {
    const before = fixture.join('\n')
    const { text: after, hits } = replaceEnvValue(before, KEY, NEW)
    assert.equal(hits, 1, 'deve casar exatamente 1 linha SERPAPI_KEY')
    const { problems, changedLines } = verifyOnlyKeyChanged(before, after, KEY)
    assert.deepEqual(problems, [], 'nenhuma outra var pode mudar (LF)')
    assert.equal(changedLines.length, 1, 'exatamente 1 linha muda (LF)')
    assert.ok(after.includes(`SERPAPI_KEY=${NEW}`), 'chave nova presente')
    assert.ok(!after.includes('SERPAPI_KEY=0000'), 'chave antiga removida')
    // DATABASE_URL com '=' e '@' no valor deve ficar INTACTA
    assert.ok(after.includes('DATABASE_URL=postgres://postgres:senha-com=e:arroba@proxy_enotel-db:5432/enotel-db?sslmode=disable'), 'DATABASE_URL preservada byte a byte')
    assert.equal(envKeys(after).length, 17, 'as 17 chaves continuam la')
    pass += 5
  }

  // 2. CRLF preservado
  {
    const before = fixture.join('\r\n')
    const { text: after } = replaceEnvValue(before, KEY, NEW)
    assert.ok(after.includes('\r\n'), 'CRLF preservado')
    assert.deepEqual(verifyOnlyKeyChanged(before, after, KEY).problems, [], 'nenhuma outra var muda (CRLF)')
    pass += 2
  }

  // 3. comentario com o nome da chave NAO e tocado
  {
    const before = '# SERPAPI_KEY: rotacione isto\nSERPAPI_KEY=old\nPORT=3000'
    const { text: after, hits } = replaceEnvValue(before, KEY, NEW)
    assert.equal(hits, 1, 'comentario nao conta como hit')
    assert.ok(after.startsWith('# SERPAPI_KEY: rotacione isto'), 'comentario intacto')
    pass += 2
  }

  // 4. chave ausente => 0 hits (o main aborta nesse caso)
  {
    const before = 'PORT=3000\nNODE_ENV=production'
    const { hits } = replaceEnvValue(before, KEY, NEW)
    assert.equal(hits, 0, 'sem SERPAPI_KEY => 0 hits')
    pass += 1
  }

  console.log(`[self-test] OK — ${pass} asserts passaram. Logica read-modify-write nao zera outras vars.`)
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main () {
  const apply = process.argv.includes('--apply')

  if (process.argv.includes('--self-test')) { selfTest(); return }

  if (!PANEL) {
    console.error('Faltou EASYPANEL_URL no ambiente (ex.: http://SEU-PAINEL:3000). Ver CONTEXTO-ENOTEL §1.')
    process.exit(1)
  }
  if (!TOKEN) {
    console.error('Faltou EASYPANEL_TOKEN no ambiente. (Use --self-test para validar offline.)')
    process.exit(1)
  }

  console.log(`EasyPanel: ${PANEL}  ·  ${PROJECT}/${SERVICE}`)
  console.log('Lendo env atual (inspectService, read-only)…')
  const before = await fetchEnv()
  const keys = envKeys(before)
  console.log(`  ${keys.length} variaveis: ${keys.join(', ')}`)
  console.log(`  SERPAPI_KEY atual: ${mask(currentKeyValue(before))}`)

  const newKey = process.env.NEW_SERPAPI_KEY || ''
  // Em dry-run sem chave nova, usa um marcador so pra provar a transformacao.
  const value = newKey || 'DRY_RUN_PLACEHOLDER_SEM_CHAVE_NOVA'

  const { text: after, hits } = replaceEnvValue(before, KEY, value)
  if (hits !== 1) {
    console.error(`\n[ABORTADO] esperava 1 linha SERPAPI_KEY, achei ${hits}. Nao vou escrever.`)
    process.exit(1)
  }
  const { problems, changedLines } = verifyOnlyKeyChanged(before, after, KEY)
  console.log(`\nVerificacao: ${changedLines.length} linha(s) alterada(s), ${problems.length} problema(s).`)
  if (problems.length) {
    console.error('[ABORTADO] a transformacao alteraria outras variaveis:')
    for (const p of problems) console.error('  - ' + p)
    process.exit(1)
  }
  console.log('  OK — SO a linha SERPAPI_KEY muda; DATABASE_URL/JWT_SECRET/ADMIN_*/… intactos.')

  if (!apply) {
    console.log('\n[DRY-RUN] Nada foi enviado. Para aplicar de verdade:')
    console.log('  EASYPANEL_TOKEN=… NEW_SERPAPI_KEY=<chave-nova> node scripts/rotate-serpapi-key.mjs --apply')
    return
  }

  // ── caminho de escrita (--apply) ──
  if (!newKey) {
    console.error('\n[ABORTADO] --apply exige NEW_SERPAPI_KEY no ambiente. Rode a rotacao na SerpAPI primeiro.')
    process.exit(1)
  }
  if (newKey === currentKeyValue(before)) {
    console.error('\n[ABORTADO] NEW_SERPAPI_KEY e igual a atual. A chave nao foi rotacionada.')
    process.exit(1)
  }

  console.log(`\nAplicando: SERPAPI_KEY ${mask(currentKeyValue(before))} -> ${mask(newKey)}`)
  await trpc('services.app.updateEnv', { projectName: PROJECT, serviceName: SERVICE, env: after }, { mutation: true })
  console.log('  updateEnv OK. Disparando deploy…')
  await trpc('services.app.deployService', { projectName: PROJECT, serviceName: SERVICE }, { mutation: true })
  console.log('  deployService OK.')
  console.log('\nAgora confira (aguarde ~1-2 min o build):')
  console.log('  - GET https://proxy-enotel.p9jgkb.easypanel.host/health  (uptime volta pra poucos seg)')
  console.log('  - GET https://proxy-enotel.p9jgkb.easypanel.host/api/serpapi/diagnose  (chave OK)')
  console.log('  - A chave ANTIGA deve passar a dar erro na SerpAPI.')
}

// So roda main quando executado direto (permite importar as funcoes nos testes
// sem disparar chamadas de rede). Comparar pelo basename e robusto no Windows,
// onde import.meta.url (file:///C:/...) e process.argv[1] (C:\...) divergem.
const invoked = (process.argv[1] || '').replace(/\\/g, '/').split('/').pop()
if (invoked === 'rotate-serpapi-key.mjs') {
  main().catch((err) => { console.error(`\n[erro] ${err.message}`); process.exit(1) })
}
