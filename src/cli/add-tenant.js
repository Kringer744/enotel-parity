// CLI de provisionamento de tenant -- runbook do Forja (Caminho B, container
// multi-tenant unico). Chama a MESMA funcao provisionTenant que a rota superadmin
// POST /tenants usa: fonte unica, sem divergencia.
//
// Uso:
//   node src/cli/add-tenant.js --slug acme --name "Acme Resort" \
//     --admin-email admin@acme.com [--admin-password segredo1234] \
//     [--subject-name "Acme Resort" --serp-query "Acme resort cidade UF" \
//      --city "Cidade, UF" --direct-url https://acme.com] \
//     [--vertical hotel] [--logo-url https://...] [--primary-color #123456]
//
// Sem --admin-password, gera um CONVITE de uso unico (72h) e imprime o link.
import { migrate } from '../db/migrate.js'
import { provisionTenant, closePool, ProvisionError } from '../services/provisioning.js'

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    out[key] = (next && !next.startsWith('--')) ? argv[++i] : 'true'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (!args.slug || !args.name || !args['admin-email']) {
  console.error(
    'Uso: node src/cli/add-tenant.js --slug <slug> --name "<Nome>" --admin-email <email>\n' +
    '  [--admin-password <senha>] [--admin-name "<Nome>"]\n' +
    '  [--subject-name "<Nome>" --serp-query "<consulta>" --city "<cidade>" --direct-url <url>]\n' +
    '  [--vertical hotel] [--logo-url <https>] [--primary-color <#RRGGBB>] [--accent-color <#RRGGBB>]'
  )
  process.exit(1)
}

const input = {
  slug: args.slug,
  name: args.name,
  vertical: args.vertical || 'hotel',
  branding: {
    logo_url: args['logo-url'],
    primary_color: args['primary-color'],
    accent_color: args['accent-color']
  },
  admin: {
    email: args['admin-email'],
    name: args['admin-name'],
    password: args['admin-password']
  },
  subject: args['subject-name']
    ? {
        name: args['subject-name'],
        serpQuery: args['serp-query'],
        city: args.city,
        directUrl: args['direct-url']
      }
    : null
}

try {
  await migrate() // garante o schema (idempotente)
  const result = await provisionTenant(input)
  console.log('Tenant provisionado:')
  console.log(JSON.stringify(result, null, 2))
  if (result.admin.mode === 'invite') {
    console.log(`\nConvite do admin (uso unico, expira em 72h): ${result.admin.invitePath}`)
    console.log('Entregue este link ao admin do tenant para ele definir a senha.')
  } else {
    console.log(`\nAdmin criado: ${result.admin.email} (login imediato com a senha informada).`)
  }
  await closePool()
  process.exit(0)
} catch (err) {
  if (err instanceof ProvisionError) console.error(`Erro (${err.status}): ${err.message}`)
  else console.error('Falha no provisionamento:', err.message)
  await closePool().catch(() => {})
  process.exit(1)
}
