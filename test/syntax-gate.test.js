import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Portao de release automatizado (checklist do usuario):
//   1) node --check em TODO JS (src, public, scripts)  -> pega o bug de sintaxe
//      do Lucide (#9): createIcons cravado no meio de uma expressao, `\n` literal.
//   2) import-check do backend: resolve toda a arvore de src/routes/index.js.
// Ambos rodam sem banco e sem rede.

const root = fileURLToPath(new URL('..', import.meta.url))

function jsFilesIn (subdir) {
  const base = join(root, subdir)
  let entries = []
  try {
    entries = readdirSync(base, { recursive: true, withFileTypes: true })
  } catch { return [] }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

test('node --check passa em todo JS de src/, public/ e scripts/', () => {
  const files = [...jsFilesIn('src'), ...jsFilesIn('public'), ...jsFilesIn('scripts')]
  assert.ok(files.length >= 10, `esperava varios arquivos JS, achei ${files.length}`)

  const falhas = []
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
    if (r.status !== 0) falhas.push(`${f}\n${r.stderr}`)
  }
  assert.equal(falhas.length, 0, `node --check falhou em:\n${falhas.join('\n---\n')}`)
})

test('import-check: src/routes/index.js resolve toda a arvore de imports', () => {
  const routesUrl = new URL('../src/routes/index.js', import.meta.url).href
  const code =
    `import(${JSON.stringify(routesUrl)})` +
    `.then(() => { console.log('IMPORT_OK') })` +
    `.catch((e) => { console.error(e?.stack || e); process.exit(1) })`

  const r = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
      JWT_SECRET: 'test-secret-para-import-check',
      SERPAPI_KEY: 'k',
      NODE_ENV: 'test'
    }
  })

  assert.equal(r.status, 0, `import-check falhou:\n${r.stderr}`)
  assert.match(r.stdout, /IMPORT_OK/)
})
