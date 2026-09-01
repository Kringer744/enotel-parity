# Deploy no EasyPanel

Duas rotas. A **A** é manual pelo painel e funciona em qualquer versão do
EasyPanel. A **B** automatiza tudo via API.

Em ambas você precisa de um **repositório Git** com este código (GitHub, GitLab
ou Gitea). O EasyPanel constrói a imagem a partir do repositório — não há upload
de pasta.

---

## Rota A — pelo painel (recomendada na primeira vez)

### 1. Criar o projeto

Painel → **Create Project** → nome `enotel`.

### 2. Criar o banco de dados

Dentro do projeto → **+ Service** → **Postgres**.

| Campo | Valor |
|---|---|
| Service Name | `paridade-db` |
| Image | `postgres:16` |
| Password | *(gere uma forte e anote)* |

Clique em **Create** e depois em **Deploy**.

Abra o serviço → aba **Credentials**. Anote o host interno, que segue o padrão
`enotel_paridade-db`. A URL de conexão fica:

```
postgres://postgres:SUA_SENHA@enotel_paridade-db:5432/paridade-db?sslmode=disable
```

> O host interno é `<projeto>_<serviço>`. Os serviços se enxergam pela rede
> interna do Docker — o Postgres **não** precisa ser exposto à internet.

### 3. Criar a aplicação

Dentro do projeto → **+ Service** → **App**.

| Campo | Valor |
|---|---|
| Service Name | `paridade` |

Depois, nas abas do serviço:

**Source** → *Git*
- Repository: a URL do seu repositório
- Branch: `main`
- Build Path: `/`

**Build** → *Dockerfile*
- Dockerfile Path: `Dockerfile`

**Environment** → cole o bloco abaixo, ajustando os valores marcados:

```env
NODE_ENV=production
PORT=3000

JWT_SECRET=COLE_AQUI_64_CARACTERES_ALEATORIOS
ADMIN_EMAIL=lucas.monteiro@fluxodigitaltech.com.br
ADMIN_PASSWORD=DEFINA_UMA_SENHA_FORTE
ADMIN_NAME=Lucas Monteiro

DATABASE_URL=postgres://postgres:SUA_SENHA@enotel_paridade-db:5432/paridade-db?sslmode=disable
PGSSLMODE=disable

SERPAPI_KEY=1c89f17984f1158bb7b026ac664c41c983e8219e0c75bc7194841eb8ae4719af
SERPAPI_MONTHLY_LIMIT=250
SERPAPI_RESERVE=25

UAZAPI_URL=
UAZAPI_ADMIN_TOKEN=
UAZAPI_INSTANCE_TOKEN=

SCAN_CRON=10 6 * * *
SCAN_TIMEZONE=America/Recife
SCHEDULER_ENABLED=true
```

Para gerar o `JWT_SECRET`, no terminal do seu computador:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Domains** → adicione seu domínio (ex.: `paridade.seudominio.com.br`),
**HTTPS ligado**, porta `3000`. O EasyPanel emite o certificado Let's Encrypt
sozinho.

**Deploy** → clique em Deploy e acompanhe os logs.

### 4. Primeiro acesso

Abra o domínio. O schema e o usuário administrador são criados automaticamente
no primeiro boot. Entre com o `ADMIN_EMAIL` e o `ADMIN_PASSWORD` que você
definiu.

Nos logs você deve ver:

```
[migrate] usuario administrador criado: ...
[migrate] schema e dados iniciais aplicados
[scheduler] varredura agendada "10 6 * * *" (America/Recife)
[boot] Enotel Paridade rodando na porta 3000 (production)
```

### 5. Ligar o WhatsApp

Isto exige uma instância uazapi (contratada em uazapi.com ou self-hosted).

1. Preencha `UAZAPI_URL` e `UAZAPI_ADMIN_TOKEN` no Environment e faça Deploy.
2. No sistema, vá em **WhatsApp** → **Criar instância** → **Gerar QR code**.
3. No celular: WhatsApp → Aparelhos conectados → Conectar aparelho → leia o QR.
4. A tela detecta a conexão sozinha e libera **Carregar contatos**.
5. Clique no contato ou grupo que deve receber os alertas.
6. Use **Testar** para confirmar o envio antes da primeira varredura.

> Use um número dedicado. Um número que já é usado pessoalmente pode ter a
> sessão derrubada ao ser pareado em outro lugar.

### 6. Primeira varredura

**Painel** → **Varredura agora**. Leva de 10 a 40 segundos. Confira em
**Tarifas atuais** se os canais foram capturados e se a tarifa direta apareceu.

**Atenção:** cada varredura consome requisições reais do orçamento de 250. Com 3 alvos
ativos, são 3 requisições (4 na primeiríssima, que descobre o `property_token`).

---

## Rota B — automatizada via API

Requer Node 20+ na sua máquina e a URL do painel.

```bash
node scripts/easypanel-deploy.js \
  --url https://painel.seudominio.com \
  --token SEU_TOKEN_EASYPANEL \
  --repo https://github.com/voce/enotel-parity \
  --branch main \
  --domain paridade.seudominio.com.br \
  --serpapiKey 1c89f17984f1158bb7b026ac664c41c983e8219e0c75bc7194841eb8ae4719af
```

O script cria projeto, Postgres, app, variáveis, porta, domínio e dispara o
deploy. Ele gera senhas fortes e **imprime no fim** a senha do Postgres, o
`JWT_SECRET` e a senha do admin — copie antes de fechar o terminal.

Rodar de novo é seguro: serviços que já existem são reaproveitados.

Se todos os procedimentos derem 404, sua versão do EasyPanel usa outra API —
use a Rota A.

---

## Operação

**Backup do banco.** No serviço Postgres do EasyPanel, aba **Backups**,
configure destino S3 e frequência diária. O histórico de tarifas é o ativo do
sistema: sem ele, não há série temporal nem prova de violação passada.

**Escalonamento.** Mantenha **1 réplica**. Com mais de uma, o cron dispararia em
paralelo e cada réplica gastaria o orçamento SerpAPI por conta própria. Se
precisar escalar, deixe `SCHEDULER_ENABLED=true` em apenas uma.

**Health check.** `GET /health` responde 200 com o banco acessível e 503 quando
não. O Dockerfile já expõe isso ao Docker.

**Atualizações.** `git push` na branch configurada e **Deploy** no painel (ou
ligue o auto-deploy por webhook do EasyPanel). O schema é idempotente: cada boot
reaplica com segurança.

**Trocar o horário da varredura.** Ajuste `SCAN_CRON` no Environment e faça
Deploy. O formato é cron padrão de 5 campos, no fuso de `SCAN_TIMEZONE`.
