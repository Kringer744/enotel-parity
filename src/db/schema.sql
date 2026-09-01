-- Enotel BR - Monitoramento de Paridade Tarifaria
-- Schema idempotente: seguro rodar em todo boot.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Canais de venda. 'direct' e a ancora de paridade; 'ota' sao os comparados.
CREATE TABLE IF NOT EXISTS channels (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ota' CHECK (kind IN ('direct', 'ota')),
  -- Padroes (lowercase) usados para casar o campo "source" da SerpAPI com este canal
  patterns   TEXT[] NOT NULL DEFAULT '{}',
  color      TEXT NOT NULL DEFAULT '#2a78d6',
  sort_order INTEGER NOT NULL DEFAULT 100,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS properties (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  -- Consulta enviada ao Google Hotels via SerpAPI
  serp_query          TEXT NOT NULL,
  -- Token do hotel na SerpAPI. Cacheado para economizar 1 requisicao por varredura.
  serp_property_token TEXT,
  city                TEXT,
  currency            TEXT NOT NULL DEFAULT 'BRL',
  direct_url          TEXT,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cada alvo = 1 requisicao SerpAPI por varredura. E aqui que o orcamento e gasto.
--
-- Dois modos:
--   'rolling' -- janela movel: check-in = hoje + horizon_days. A data anda todo
--                dia, entao serve para acompanhar o comportamento geral do
--                canal, nao a curva de uma estadia especifica.
--   'fixed'   -- data de calendario fixa. Amostrada todo dia, revela a curva
--                real de preco daquela estadia conforme ela se aproxima.
CREATE TABLE IF NOT EXISTS scan_targets (
  id           SERIAL PRIMARY KEY,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  los          INTEGER NOT NULL DEFAULT 2,
  adults       INTEGER NOT NULL DEFAULT 2,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, horizon_days, los, adults)
);

-- Colunas do modo 'fixed'. Idempotente: bancos ja provisionados recebem aqui.
ALTER TABLE scan_targets ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'rolling';
ALTER TABLE scan_targets ADD COLUMN IF NOT EXISTS check_in  DATE;
ALTER TABLE scan_targets ADD COLUMN IF NOT EXISTS check_out DATE;
-- horizon_days so faz sentido no modo 'rolling'
ALTER TABLE scan_targets ALTER COLUMN horizon_days DROP NOT NULL;

-- Evita cadastrar a mesma estadia duas vezes. Parcial: nao afeta 'rolling',
-- que ja tem a sua propria UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_fixed
  ON scan_targets (property_id, check_in, check_out, adults)
  WHERE mode = 'fixed';

CREATE TABLE IF NOT EXISTS scans (
  id             SERIAL PRIMARY KEY,
  trigger        TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed', 'skipped')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  requests_used  INTEGER NOT NULL DEFAULT 0,
  targets_total  INTEGER NOT NULL DEFAULT 0,
  targets_ok     INTEGER NOT NULL DEFAULT 0,
  rates_captured INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  message        TEXT
);

CREATE TABLE IF NOT EXISTS rates (
  id          BIGSERIAL PRIMARY KEY,
  scan_id     INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id   INTEGER REFERENCES scan_targets(id) ON DELETE SET NULL,
  check_in    DATE NOT NULL,
  check_out   DATE NOT NULL,
  los         INTEGER NOT NULL,
  adults      INTEGER NOT NULL,
  -- Diaria media, moeda da propriedade
  price       NUMERIC(12,2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'BRL',
  source_raw  TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rates_scan       ON rates(scan_id);
CREATE INDEX IF NOT EXISTS idx_rates_lookup     ON rates(property_id, check_in, channel_id);
CREATE INDEX IF NOT EXISTS idx_rates_captured   ON rates(captured_at DESC);

-- Uma violacao = um canal OTA vendendo fora da regra contra a tarifa ancora.
CREATE TABLE IF NOT EXISTS findings (
  id            BIGSERIAL PRIMARY KEY,
  scan_id       INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- NULL para 'missing_direct': o achado é sobre a ausência da âncora, não sobre
  -- um canal específico.
  channel_id    INTEGER REFERENCES channels(id) ON DELETE CASCADE,
  target_id     INTEGER REFERENCES scan_targets(id) ON DELETE SET NULL,
  check_in      DATE NOT NULL,
  check_out     DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('undercut', 'overcut', 'missing_direct', 'missing_channel')),
  base_price    NUMERIC(12,2),
  channel_price NUMERIC(12,2),
  delta_abs     NUMERIC(12,2),
  delta_pct     NUMERIC(8,3),
  severity      TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'serious', 'critical')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  notified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bancos criados antes desta mudanca ainda tem channel_id NOT NULL; remover a
-- restricao e no-op quando ela ja nao existe.
ALTER TABLE findings ALTER COLUMN channel_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_findings_scan    ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_open    ON findings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_channel ON findings(channel_id, created_at DESC);

-- Destinatarios dos alertas de paridade no WhatsApp.
CREATE TABLE IF NOT EXISTS whatsapp_recipients (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,   -- E.164 sem '+', ex: 5581999998888
  jid        TEXT,
  is_group   BOOLEAN NOT NULL DEFAULT FALSE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  scan_id      INTEGER REFERENCES scans(id) ON DELETE SET NULL,
  recipient_id INTEGER REFERENCES whatsapp_recipients(id) ON DELETE SET NULL,
  phone        TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);

-- Consumo da SerpAPI por mes. Chave 'YYYY-MM'. O contador e a fonte da verdade
-- do orcamento; incrementado ANTES da chamada para nunca estourar por corrida.
CREATE TABLE IF NOT EXISTS api_usage (
  month      TEXT PRIMARY KEY,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT,
  action     TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
