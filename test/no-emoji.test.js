import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// PRD (Bussola) I1-CA3 / §6.4 + principio inegociavel do usuario: ZERO emoji na
// interface. Icones sao Lucide (data-lucide), nunca emoji. Este guard varre a
// interface (public/) sem precisar de browser.
//
// Faixas de emoji/pictogramas — de proposito NAO inclui a Pontuacao Geral
// (U+2000–206F), onde vivem o travessao "—" (U+2014) e as reticencias, nem os
// acentos do portugues.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u

const publicDir = fileURLToPath(new URL('../public', import.meta.url))

function interfaceFiles (dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...interfaceFiles(p))
    else if (/\.(html|css|js)$/.test(e.name)) out.push(p)
  }
  return out
}

test('zero emoji na interface (public/ html/css/js) — so Lucide', () => {
  const files = interfaceFiles(publicDir)
  assert.ok(files.length >= 4, `esperava os arquivos de interface, achei ${files.length}`)
  const hits = []
  for (const f of files) {
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (EMOJI.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`)
    })
  }
  assert.equal(hits.length, 0, `emoji encontrado na interface:\n${hits.join('\n')}`)
})
