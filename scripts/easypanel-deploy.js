#!/usr/bin/env node
/**
 * Provisiona a stack no EasyPanel via API.
 *
 * Cria: projeto -> serviço Postgres -> serviço App (com env) -> deploy.
 * É idempotente: serviços que já existem são reaproveitados, não recriados.
 *
 * Uso:
 *   node scripts/easypanel-deploy.js --url https://painel.seudominio.com \
 *        --token <EASYPANEL_TOKEN> --repo https://github.com/voce/enotel-parity
 *
 * Ou definindo EASYPANEL_URL / EASYPANEL_TOKEN no ambiente.
 */

import { randomBytes } from 'node:crypto'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, [])
)

const PANEL = (args.url || process.env.EASYPANEL_URL || '').replace(/\/+$/, '')
const TOKEN = args.token || process.env.EASYPANEL_TOKEN || ''
const PROJECT = args.project || 'enotel'
const APP = args.app || 'paridade'
const DB = args.db || 'paridade-db'
const DOMAIN = args.domain || null

if (!PANEL || !TOKEN) {
  console.error('Faltou --url (URL do painel EasyPanel) e/ou --token.')
  console.error('Ex.: node scripts/easypanel-deploy.js --url https://painel.exemplo.com --token abc123 --repo https://github.com/voce/enotel-parity')
  process.exit(1)
}

const secret = (n = 32) => randomBytes(n).toString('hex')
const dbPassword = args.dbPassword || secret(16)
const jwtSecret = args.jwtSecret || secret(32)
const adminPassword = args.adminPassword || secret(8)

/** O EasyPanel expõe tRPC: mutations em POST /api/trpc/<proc> com body {json}. */
async function trpc (procedure, input, { mutation = true } = {}) {
  const url = mutation
    ? `${PANEL}/api/trpc/${procedure}`
    : `${PANEL}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`

  const res = await fetch(url, {
    method: mutation ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: mutation ? JSON.stringify({ json: input }) : undefined
  })

  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }

  if (!res.ok) {
    const msg = data?.error?.json?.message || data?.error?.message || `HTTP ${res.status}`
    const err = new Error(`${procedure}: ${msg}`)
    err.status = res.status
    err.body = data
    throw err
  }
  return data?.result?.data?.json ?? data
}

/** Trata "já existe" como sucesso — o script precisa poder rodar de novo. */
async function ensure (label, fn) {
  try {
    const out = await fn()
    console.log(`  [ok]    ${label}`)
    return out
  } catch (err) {
    if (/already exists|já existe|duplicate/i.test(err.message)) {
      console.log(`  [pulou] ${label} (já existia)`)
      return null
    }
    throw err
  }
}

const ENV = ({ dbUrl }) => [
  'NODE_ENV=production',
  'PORT=3000',
  `JWT_SECRET=${jwtSecret}`,
  `ADMIN_EMAIL=${args.adminEmail || 'lucas.monteiro@fluxodigitaltech.com.br'}`,
  `ADMIN_PASSWORD=${adminPassword}`,
  'ADMIN_NAME=Lucas Monteiro',
  `DATABASE_URL=${dbUrl}`,
  'PGSSLMODE=disable',
  `SERPAPI_KEY=${args.serpapiKey || process.env.SERPAPI_KEY || ''}`,
  'SERPAPI_MONTHLY_LIMIT=250',
  'SERPAPI_RESERVE=25',
  `UAZAPI_URL=${args.uazapiUrl || process.env.UAZAPI_URL || ''}`,
  `UAZAPI_ADMIN_TOKEN=${args.uazapiToken || process.env.UAZAPI_ADMIN_TOKEN || ''}`,
  'UAZAPI_INSTANCE_TOKEN=',
  'SCAN_CRON=10 6 * * *',
  'SCAN_TIMEZONE=America/Recife',
  'SCHEDULER_ENABLED=true'
].join('\n')

async function main () {
  console.log(`\nEasyPanel: ${PANEL}`)
  console.log(`Projeto: ${PROJECT}  ·  App: ${APP}  ·  Banco: ${DB}\n`)

  console.log('1. Projeto')
  await ensure(`projeto "${PROJECT}"`, () =>
    trpc('projects.createProject', { name: PROJECT }))

  console.log('2. Banco de dados Postgres')
  await ensure(`serviço postgres "${DB}"`, () =>
    trpc('services.postgres.createService', {
      projectName: PROJECT,
      serviceName: DB,
      image: 'postgres:16',
      password: dbPassword
    }))

  // Dentro da rede do EasyPanel os serviços se enxergam por <projeto>_<serviço>.
  const dbHost = `${PROJECT}_${DB}`
  const dbUrl = `postgres://postgres:${dbPassword}@${dbHost}:5432/${DB}?sslmode=disable`

  await ensure('deploy do postgres', () =>
    trpc('services.postgres.deployService', { projectName: PROJECT, serviceName: DB }))

  console.log('3. Aplicação')
  await ensure(`serviço app "${APP}"`, () =>
    trpc('services.app.createService', { projectName: PROJECT, serviceName: APP }))

  if (args.repo) {
    await ensure(`fonte Git (${args.repo})`, () =>
      trpc('services.app.updateSourceGit', {
        projectName: PROJECT,
        serviceName: APP,
        repo: args.repo,
        ref: args.branch || 'main',
        path: '/'
      }))
    await ensure('build via Dockerfile', () =>
      trpc('services.app.updateBuild', {
        projectName: PROJECT,
        serviceName: APP,
        build: { type: 'dockerfile', file: 'Dockerfile' }
      }))
  } else if (args.image) {
    await ensure(`imagem Docker (${args.image})`, () =>
      trpc('services.app.updateSourceImage', {
        projectName: PROJECT,
        serviceName: APP,
        image: args.image
      }))
  } else {
    console.log('  ! Nenhuma fonte informada (--repo ou --image).')
    console.log('    O serviço foi criado; aponte a fonte no painel e clique em Deploy.')
  }

  await ensure('variáveis de ambiente', () =>
    trpc('services.app.updateEnv', {
      projectName: PROJECT,
      serviceName: APP,
      env: ENV({ dbUrl })
    }))

  await ensure('porta 3000 exposta', () =>
    trpc('services.app.updatePorts', {
      projectName: PROJECT,
      serviceName: APP,
      ports: [{ published: 3000, target: 3000, protocol: 'tcp' }]
    }))

  if (DOMAIN) {
    await ensure(`domínio ${DOMAIN}`, () =>
      trpc('services.app.updateDomains', {
        projectName: PROJECT,
        serviceName: APP,
        domains: [{ host: DOMAIN, https: true, port: 3000, path: '/' }]
      }))
  }

  if (args.repo || args.image) {
    console.log('4. Deploy')
    await ensure('build e start da aplicação', () =>
      trpc('services.app.deployService', { projectName: PROJECT, serviceName: APP }))
  }

  console.log('\n─────────────────────────────────────────────')
  console.log('GUARDE ESTES DADOS — não são exibidos de novo:')
  console.log(`  Senha do Postgres : ${dbPassword}`)
  console.log(`  JWT_SECRET        : ${jwtSecret}`)
  console.log(`  Senha do admin    : ${adminPassword}`)
  console.log(`  DATABASE_URL      : ${dbUrl}`)
  console.log('─────────────────────────────────────────────\n')
  if (DOMAIN) console.log(`Acesse: https://${DOMAIN}\n`)
}

main().catch((err) => {
  console.error(`\n[erro] Falhou: ${err.message}`)
  if (err.body) console.error(JSON.stringify(err.body, null, 2))
  console.error('\nSe o erro for 404 em todos os procedimentos, a versão do seu')
  console.error('EasyPanel usa outra API. Nesse caso siga DEPLOY-EASYPANEL.md (via painel).')
  process.exit(1)
})
