# Paridade Enotel BR

Plataforma de monitoramento de paridade tarifária. Varre diariamente as tarifas
do **Enotel Porto de Galinhas** nas principais OTAs via Google Hotels (SerpAPI),
compara cada canal contra a tarifa do **site oficial**, e dispara alertas no
**WhatsApp** quando alguém fura a paridade.

## O que ele faz

- **Varredura diária agendada** (cron, fuso America/Recife) + disparo manual.
- **7 canais monitorados**: site oficial Enotel (âncora), Booking.com, Expedia,
  Hoteis.com, Trip.com, MaxMilhas, Azul Viagens.
- **Motor de paridade** com tolerância configurável e 4 níveis de severidade.
- **Alertas no WhatsApp** via uazapi — conecta por QR code, você escolhe o
  contato ou grupo que recebe.
- **Relatórios**: painel com KPIs, série temporal por canal, conformidade por
  canal, heatmap de violações por dia, exportação CSV e impressão em PDF.
- **Guarda de orçamento SerpAPI**: nunca estoura as 250 requisições/mês.

## Arquitetura

Um único container Node.js serve a API e o front-end; o Postgres é um serviço
separado. O front-end é HTML/CSS/JS puro — **não há build step**, nem bundler,
nem `node_modules` no navegador. Os gráficos são SVG escritos à mão.

```
src/
  server.js              Express: API + estáticos + health check
  config.js              Env vars tipadas e validadas no boot
  db/
    schema.sql           Schema idempotente (roda a cada boot)
    migrate.js           Migração + seed de canais, propriedade, alvos, admin
    pool.js              Pool pg (NUMERIC parseado como número, não string)
  lib/
    auth.js              Login JWT, middleware, audit log
    budget.js            Contador atômico de requisições SerpAPI
  services/
    serpapi.js           Cliente Google Hotels + extração de preços
    parity.js            Motor de comparação e severidade
    scanner.js           Orquestra a varredura completa
    uazapi.js            Cliente WhatsApp (instância, QR, contatos, envio)
    notifier.js          Monta e dispara a mensagem de alerta
    reports.js           Agregações do painel e do relatório
    settings.js          Configurações persistidas com merge
  jobs/scheduler.js      node-cron
  routes/index.js        Toda a API REST
  cli/run-scan.js        `npm run scan` — varredura avulsa pelo terminal
public/
  index.html
  css/app.css            Sistema visual (tokens, claro/escuro, impressão)
  js/app.js              SPA: painel, tarifas, violações, relatório, WhatsApp, config
  js/charts.js           Linha (crosshair), barra, heatmap — SVG nativo
  js/api.js  js/ui.js
```

## O orçamento SerpAPI é a restrição de projeto

O plano tem **250 requisições/mês** e a exigência é **30 varreduras/mês**. Isso
dá **8,3 requisições por varredura** no total — para todos os canais e todas as
datas.

Duas decisões nascem daí:

1. **Uma requisição cobre todas as OTAs.** O endpoint `google_hotels` com
   `property_token` devolve Booking, Expedia, Hoteis.com, Trip.com etc. numa
   resposta só. Consultar cada OTA separadamente multiplicaria o custo por 7.
2. **O `property_token` é cacheado no banco.** Descobri-lo custa 1 requisição;
   sem cache, toda varredura pagaria esse pedágio de novo.

Configuração padrão: **3 alvos** (check-in em +7, +30 e +60 dias) × 30
varreduras = **90 requisições/mês**, com folga de 160.

A guarda de orçamento (`src/lib/budget.js`) incrementa o contador **antes** da
chamada HTTP, então duas varreduras simultâneas nunca estouram o teto juntas.
Requisições que falham na rede são estornadas. Uma **reserva de 25 requisições**
fica separada: só disparos manuais podem consumi-la, para você sempre ter como
investigar algo suspeito no fim do mês.

A tela **Configurações** mostra a projeção de consumo até o fim do mês e quantos
alvos por varredura ainda cabem.

## Regra de paridade

A âncora é a **tarifa do site oficial**. Uma OTA vendendo abaixo dela é
violação (`undercut`) — é o hóspede que compraria direto migrando para o canal
comissionado.

| Severidade | Desconto da OTA frente ao direto |
|---|---|
| Atenção  | ≥ 1%  |
| Grave    | ≥ 5%  |
| Crítico  | ≥ 10% |

Diferenças abaixo de 1% **ou** de R$ 5,00/diária são ignoradas (ruído de
arredondamento e câmbio). Tudo é configurável na interface.

Casos especiais que também viram achado:
- `missing_direct` — o site oficial sumiu do Google Hotels: sem âncora, nenhuma
  comparação do dia é válida.
- `missing_channel` — um canal monitorado não apareceu na oferta.

## Rodando localmente

Requer Node 20+ e Postgres (ou só Docker).

```bash
cp .env.example .env      # preencha DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD
npm install
npm start                 # migra o banco e sobe em http://localhost:3000
```

Com Docker:

```bash
docker compose up --build
```

Testar a integração SerpAPI sem esperar o cron (**gasta requisições reais**):

```bash
npm run scan
```

## Deploy

Veja **[DEPLOY-EASYPANEL.md](DEPLOY-EASYPANEL.md)**.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | String de conexão do Postgres |
| `JWT_SECRET` | sim (produção) | Segredo de assinatura da sessão |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | sim | Usuário criado no primeiro boot |
| `SERPAPI_KEY` | sim | Chave da SerpAPI |
| `SERPAPI_MONTHLY_LIMIT` | não (250) | Teto duro de requisições/mês |
| `SERPAPI_RESERVE` | não (25) | Reserva para disparos manuais |
| `UAZAPI_URL` | para WhatsApp | Ex.: `https://sua.uazapi.com` |
| `UAZAPI_ADMIN_TOKEN` | para WhatsApp | Token de admin do servidor uazapi |
| `UAZAPI_INSTANCE_TOKEN` | não | Fixa uma instância já existente |
| `SCAN_CRON` | não (`10 6 * * *`) | Agendamento da varredura |
| `SCAN_TIMEZONE` | não (`America/Recife`) | Fuso do agendamento |
| `SCHEDULER_ENABLED` | não (`true`) | Ligue em **uma só** réplica |

## Limitações conhecidas

- **MaxMilhas e Azul Viagens** raramente aparecem como anunciantes no Google
  Hotels para resorts do Nordeste. Os canais estão cadastrados e serão captados
  automaticamente quando aparecerem; enquanto não aparecem, a tela de Violações
  os mostra como `missing_channel`. Cobri-los de forma garantida exigiria
  scraping direto desses sites, que é outra fonte de dados e outro custo.
- A tarifa direta depende de o site oficial estar listado no Google Hotels. Se
  ele sair da listagem, o sistema reporta `missing_direct` em vez de comparar
  contra uma âncora errada.
- Os preços são **diárias médias** normalizadas para a estadia consultada, não
  tarifas de um plano específico (café da manhã, reembolsável etc.). Para
  auditoria contratual, use os achados como gatilho de verificação manual.
