// Side-effect import: define variaveis de ambiente ANTES de qualquer modulo do
// projeto ser avaliado. Importe este arquivo como PRIMEIRA linha de todo teste
// que toque em config/pool/serpapi/budget. Em ESM os imports irmaos avaliam na
// ordem do codigo, entao este roda antes de config.js.
//
// Nada aqui conecta em banco ou rede: o pool do pg so abre conexao na primeira
// query real, e os testes substituem pool.query / global.fetch por stubs.

process.env.NODE_ENV ??= 'test'
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/testdb'
process.env.JWT_SECRET ??= 'test-secret-para-suite-de-regressao-nao-usar-em-producao-000'
process.env.SERPAPI_KEY ??= 'test-serpapi-key'
process.env.SERPAPI_MONTHLY_LIMIT ??= '250'
process.env.SERPAPI_RESERVE ??= '25'
process.env.PGSSLMODE ??= 'disable'
