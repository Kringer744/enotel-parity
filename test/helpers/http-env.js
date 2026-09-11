// Deve ser o PRIMEIRO import dos testes de rota/HTTP: aponta o pool do APP
// (que le DATABASE_URL em src/config.js) para o Postgres de TESTE, e so quando
// TEST_DATABASE_URL existe. Sem isso, o pool fica no dummy e o probe faz skip.
//
// Roda antes de env.js (que so usa ??=) e antes de qualquer src/*, entao o
// config do app ja nasce apontando pro banco de teste. Processo isolado por
// arquivo de teste -> nao contamina os outros.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}
