import './helpers/env.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { pgProbe, pgEnd, resolveTable } from './helpers/pg.js'

// ISOLAMENTO MULTI-TENANT (branch feat/plataforma-multitenant).
// Contrato acordado com Bastiao (SEGURANCA §4), Cortex (RFC §3/§4/§9) e Nucleo
// (AUTH-API §5/§6.4). Prova: tenant A nunca le nem escreve dado de B.
//
// Estes testes sao de INTEGRACAO -- rodam contra um Postgres com o schema
// multi-tenant publicado (TEST_DATABASE_URL). Sem isso, SKIP limpo. As camadas:
//   - Nivel SCHEMA/DADOS (aqui, ligam assim que o Cortex publicar o schema):
//     tenant_id NOT NULL, uniques compostas, leitura escopada, convite token_hash.
//   - Nivel ROTA/HTTP (2a onda, quando Nucleo entregar scopeTenant/requireRole):
//     matriz endpoint x tenant, tenant forjado em body/param, papeis.

const probe = await pgProbe()
const skip = probe.ready ? false : probe.reason
const pool = probe.pool

after(async () => { await pgEnd() })

// Tabelas de dados que NUNCA podem cruzar tenant (Bastiao §4).
const STRICT = ['channels', 'scans', 'rates', 'findings', 'whatsapp_recipients', 'notifications', 'api_usage', 'settings']
// tenant_id existe mas e NULLABLE por desenho (superadmin / acoes de plataforma).
const NULLABLE_OK = ['users', 'audit_log']

test('#F2 tenant_id NOT NULL em toda tabela de dados (e presente em users/audit_log)', { skip }, async () => {
  const subjects = await resolveTable(pool, ['subjects', 'properties'])
  const targets = await resolveTable(pool, ['targets', 'scan_targets'])
  for (const t of [...STRICT, subjects, targets].filter(Boolean)) {
    const { rows } = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id'", [t])
    assert.equal(rows.length, 1, `${t} tem coluna tenant_id`)
    assert.equal(rows[0].is_nullable, 'NO', `${t}.tenant_id deve ser NOT NULL`)
  }
  for (const t of NULLABLE_OK) {
    const { rows } = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id'", [t])
    assert.equal(rows.length, 1, `${t} tem coluna tenant_id`)
  }
})

test('#F2 (a) leitura escopada por tenant_id nao vaza + unique composta permite mesma chave por tenant', { skip }, async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const mk = async (slug) => (await client.query('INSERT INTO tenants (slug,name) VALUES ($1,$2) RETURNING id', [slug, slug])).rows[0].id
    const a = await mk(`iso-a-${Date.now()}`)
    const b = await mk(`iso-b-${Date.now()}`)
    // Mesma chave natural 'parity' nos dois tenants: unique composta (tenant_id,key) permite.
    await client.query("INSERT INTO settings (tenant_id,key,value) VALUES ($1,'parity','{\"who\":\"A\"}')", [a])
    await client.query("INSERT INTO settings (tenant_id,key,value) VALUES ($1,'parity','{\"who\":\"B\"}')", [b])
    // Leitura escopada de A ve SO a linha de A.
    const ra = await client.query("SELECT value FROM settings WHERE tenant_id=$1 AND key='parity'", [a])
    assert.equal(ra.rows.length, 1, 'A ve exatamente 1 linha')
    assert.deepEqual(ra.rows[0].value, { who: 'A' }, 'A ve o proprio valor, nunca o de B')
  } finally {
    await client.query('ROLLBACK'); client.release()
  }
})

test('#F2 convite: token_hash resolve o tenant do proprio token; forte/unico/expira/uso-unico (excecao legitima, NAO e vazamento)', { skip }, async () => {
  // token_hash e UNIQUE por schema (Cortex RFC §3.1 / AUTH-API §6.4).
  const uniq = await pool.query(
    `SELECT 1 FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name='invites' AND tc.constraint_type='UNIQUE' AND ccu.column_name='token_hash'
     UNION
     SELECT 1 FROM pg_indexes WHERE tablename='invites' AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%token_hash%'`)
  assert.ok(uniq.rows.length >= 1, 'invites.token_hash deve ser UNIQUE')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const mk = async (slug) => (await client.query('INSERT INTO tenants (slug,name) VALUES ($1,$2) RETURNING id', [slug, slug])).rows[0].id
    const a = await mk(`inv-a-${Date.now()}`)
    const b = await mk(`inv-b-${Date.now()}`)
    const h = (raw) => crypto.createHash('sha256').update(raw).digest('hex')
    const tokA = `A.${crypto.randomBytes(16).toString('hex')}`
    const tokExp = `E.${crypto.randomBytes(16).toString('hex')}`
    const tokAcc = `C.${crypto.randomBytes(16).toString('hex')}`
    // token cru NUNCA e gravado -- so o sha256 (64 hex).
    assert.match(h(tokA), /^[0-9a-f]{64}$/)

    await client.query("INSERT INTO invites (tenant_id,email,role,token_hash,expires_at) VALUES ($1,$2,'viewer',$3, now()+interval '72 hours')", [a, 'x@a.com', h(tokA)])
    await client.query("INSERT INTO invites (tenant_id,email,role,token_hash,expires_at) VALUES ($1,$2,'viewer',$3, now()-interval '1 hour')", [b, 'z@b.com', h(tokExp)])
    await client.query("INSERT INTO invites (tenant_id,email,role,token_hash,expires_at,accepted_at) VALUES ($1,$2,'viewer',$3, now()+interval '72 hours', now())", [b, 'y@b.com', h(tokAcc)])

    const VALID = 'token_hash=$1 AND accepted_at IS NULL AND expires_at > now()'
    // O accept resolve o tenant SO pelo token (sem tenant_id) -- e o correto (A), nao B.
    const good = await client.query(`SELECT tenant_id FROM invites WHERE ${VALID}`, [h(tokA)])
    assert.equal(good.rows.length, 1)
    assert.equal(good.rows[0].tenant_id, a, 'o token resolve exatamente o tenant que o emitiu')
    // Expirado, ja aceito (uso unico) e inexistente NAO validam.
    for (const t of [tokExp, tokAcc, 'inexistente']) {
      const r = await client.query(`SELECT 1 FROM invites WHERE ${VALID}`, [h(t)])
      assert.equal(r.rows.length, 0, `token invalido rejeitado: ${t.slice(0, 1)}`)
    }
  } finally {
    await client.query('ROLLBACK'); client.release()
  }
})

// ─── Adicoes travadas com o Bastiao ──────────────────────────────────────────

test('#F2 convite ACCEPT: uso unico e atomico — 2o aceite do mesmo token falha', { skip }, async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const a = (await client.query('INSERT INTO tenants (slug,name) VALUES ($1,$2) RETURNING id', [`acc-${Date.now()}`, 'A'])).rows[0].id
    const h = (raw) => crypto.createHash('sha256').update(raw).digest('hex')
    const tok = crypto.randomBytes(24).toString('hex')
    await client.query("INSERT INTO invites (tenant_id,email,role,token_hash,expires_at) VALUES ($1,$2,'viewer',$3, now()+interval '72 hours')", [a, 'x@a.com', h(tok)])
    // O consume e um UPDATE CONDICIONAL (accepted_at IS NULL) -> atomico e uso unico.
    const CONSUME = "UPDATE invites SET accepted_at=now() WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now() RETURNING id"
    const first = await client.query(CONSUME, [h(tok)])
    assert.equal(first.rows.length, 1, 'primeiro aceite consome o token')
    const second = await client.query(CONSUME, [h(tok)])
    assert.equal(second.rows.length, 0, 'segundo aceite do MESMO token nao consome (uso unico/atomico)')
  } finally {
    await client.query('ROLLBACK'); client.release()
  }
})

test('#F2 gate de schema pos-cutover: tenant_id SEM DEFAULT (all-except api_usage) + uniques compostas', { skip }, async () => {
  // (a) tenant_id SEM DEFAULT (senao "esquecer" o tenant num INSERT nao falha --
  // o DEFAULT mascara o bug de escopo). Cutover final do Cortex = 9 tabelas
  // (findings/rates/targets/scans/channels/subjects/settings/notifications/whatsapp_recipients).
  // FAIL-CLOSED "all-except api_usage": a UNICA excecao por desenho e `api_usage`
  // (cota da chave SerpAPI COMPARTILHADA = global, §11.4; nao e dado de tenant).
  // Qualquer OUTRA tabela com tenant_id DEFAULT reprova -- inclusive tabela nova.
  const { rows: defs } = await pool.query(
    `SELECT c.relname AS tbl
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname='public' AND a.attname='tenant_id' AND c.relkind='r'
        AND c.relname <> 'api_usage'`)
  assert.equal(defs.length, 0, `tenant_id NAO pode ter DEFAULT (exceto api_usage): ${defs.map((r) => r.tbl).join(', ') || '(nenhuma)'}`)

  // (b) uniques compostas por chave natural do tenant (tabelas do cutover com
  // chave natural). api_usage fica de fora (global, sem composta por tenant em F1).
  const composite = [
    ['channels', ['tenant_id', 'slug']],
    ['settings', ['tenant_id', 'key']],
    ['whatsapp_recipients', ['tenant_id', 'phone']]
  ]
  for (const [tbl, cols] of composite) {
    const want = [...cols].sort()
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1 AND con.contype IN ('p','u')
          AND (SELECT array_agg(att.attname ORDER BY att.attname)
                 FROM unnest(con.conkey) k
                 JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=k) = $2::text[]`,
      [tbl, want])
    assert.ok(rows.length >= 1, `${tbl} precisa de unique/PK composta exatamente (${cols.join(', ')})`)
  }
})

// A 2a onda (matriz ROTA/HTTP: endpoint x tenant, tenant forjado ignorado,
// papeis, convite CREATE por claim e ACCEPT com resposta uniforme) esta no
// esqueleto test/multitenant-http.test.js -- sobe o Express real e liga sozinho
// quando o Nucleo entregar scopeTenant/requireRole.
