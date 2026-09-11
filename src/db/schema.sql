-- Plataforma de Paridade Fluxo - Schema multi-tenant, vertical-agnostico.
-- Idempotente: seguro rodar em todo boot (fresh, Enotel legado, ou ja migrado).
--
-- Estrategia de transicao (F1, RFC secao 9):
--   tenant_id entra como NOT NULL DEFAULT 1 nas tabelas de dados. Em bancos ja
--   provisionados o Postgres preenche as linhas existentes com 1 automaticamente
--   (backfill do Enotel -> tenant #1 sem passo manual) e o codigo single-tenant
--   ainda-nao-migrado continua funcionando. O DEFAULT e removido, junto das PKs
--   e uniques compostas, na peca de endurecimento ANTES de provisionar o 2o
--   tenant (so ha 1 tenant enquanto o default existe -> zero vazamento possivel).

-- ─── Tenants (o cliente) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,          -- subdomain-safe, lowercase
  name       TEXT NOT NULL,
  branding   JSONB NOT NULL DEFAULT '{}',   -- logo, paleta (white-label)
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- O Enotel e o tenant #1. Precisa existir ANTES dos ALTER que adicionam
-- tenant_id NOT NULL DEFAULT 1 REFERENCES tenants(id) (FK + backfill).
INSERT INTO tenants (id, slug, name)
  VALUES (1, 'enotel', 'Enotel')
  ON CONFLICT (id) DO NOTHING;
-- Mantem a sequence a frente do id semeado manualmente.
SELECT setval(pg_get_serial_sequence('tenants', 'id'),
              GREATEST((SELECT MAX(id) FROM tenants), 1));

-- Config de conector POR tenant: credenciais e orcamento proprios do cliente.
-- 'metered' distingue conector com cota dura (SerpAPI, passa pela guarda
-- atomica) de conector sem cota (ANP download, so alimenta o forecast).
CREATE TABLE IF NOT EXISTS tenant_connectors (
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_key TEXT NOT NULL,              -- 'hotel_serpapi', 'fuel_anp'
  config        JSONB NOT NULL DEFAULT '{}',-- api key, endpoint (segredo fora do repo)
  monthly_limit INTEGER,                    -- teto do cliente (NULL = herda do conector)
  reserve       INTEGER NOT NULL DEFAULT 0,
  metered       BOOLEAN NOT NULL DEFAULT TRUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (tenant_id, connector_key)
);

-- ─── Usuarios (tenant_id NULL = superadmin da plataforma) ────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,          -- UNIQUE global na F1 (login sem contexto de tenant)
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL p/ superadmin
  active        BOOLEAN NOT NULL DEFAULT TRUE,   -- soft-deactivate (Bastiao #3); login recusa inativo
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bancos legados: colunas novas. Backfill admin->tenant #1 no migrate.js;
-- o CHECK de role e adicionado LA, so depois do backfill (senao quebra: role='admin').
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- ─── Convites e reset de senha (token de uso unico) ──────────────────────────
-- Desenho do Nucleo (AUTH-API-PARIDADE.md secao 6.4); schema do Cortex.
-- O token CRU nunca e gravado: so o SHA-256. O lookup publico do accept e por
-- token_hash e resolve o tenant a partir do convite (unica leitura cross-tenant
-- por desenho -- o token E a credencial).
CREATE TABLE IF NOT EXISTS invites (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL CHECK (role IN ('tenant_admin', 'viewer')),
  token_hash  TEXT NOT NULL UNIQUE,          -- SHA-256; token cru so viaja no link, uma vez
  purpose     TEXT NOT NULL DEFAULT 'invite' CHECK (purpose IN ('invite', 'password_reset')),
  expires_at  TIMESTAMPTZ NOT NULL,          -- +72h (invite) / +1h (reset)
  accepted_at TIMESTAMPTZ,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_tenant ON invites(tenant_id, email);

-- ─── Canais de venda ─────────────────────────────────────────────────────────
-- 'direct' e a ancora de paridade; 'competitor'/'ota' sao os comparados.
CREATE TABLE IF NOT EXISTS channels (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,          -- UNIQUE composta (tenant_id, slug) fica p/ o endurecimento
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ota' CHECK (kind IN ('direct', 'ota', 'competitor')),
  patterns   TEXT[] NOT NULL DEFAULT '{}',
  color      TEXT NOT NULL DEFAULT '#2a78d6',
  sort_order INTEGER NOT NULL DEFAULT 100,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  tenant_id  INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

-- ─── Subjects (a coisa monitorada: hotel | posto | SKU) ──────────────────────
-- Renomeado de 'properties'. Idempotente: renomeia se o banco legado ainda tem
-- 'properties' e 'subjects' nao existe.
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'properties')
     AND NOT EXISTS (SELECT FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'subjects') THEN
    ALTER TABLE properties RENAME TO subjects;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS subjects (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  vertical            TEXT NOT NULL DEFAULT 'hotel',
  -- Campos especificos de hotel (mantidos como colunas; 'attrs' guarda extras
  -- de outros verticais).
  serp_query          TEXT,
  serp_property_token TEXT,
  city                TEXT,
  currency            TEXT NOT NULL DEFAULT 'BRL',
  direct_url          TEXT,
  attrs               JSONB NOT NULL DEFAULT '{}',
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  tenant_id           INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS vertical  TEXT NOT NULL DEFAULT 'hotel';
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS attrs     JSONB NOT NULL DEFAULT '{}';
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

-- ─── Targets (cada alvo ativo = 1 requisicao por varredura) ──────────────────
-- Renomeado de 'scan_targets'.
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'scan_targets')
     AND NOT EXISTS (SELECT FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'targets') THEN
    ALTER TABLE scan_targets RENAME TO targets;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS targets (
  id           SERIAL PRIMARY KEY,
  property_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'rolling',   -- 'rolling' | 'fixed'
  horizon_days INTEGER,                            -- so no modo 'rolling'
  los          INTEGER NOT NULL DEFAULT 2,
  adults       INTEGER NOT NULL DEFAULT 2,
  check_in     DATE,                               -- modo 'fixed'
  check_out    DATE,                               -- modo 'fixed'
  auto_key     TEXT,                               -- 'weekend'|'midweek' se automatico; NULL se manual
  params       JSONB NOT NULL DEFAULT '{}',        -- parametros por-vertical (ex.: fuel_type)
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  tenant_id    INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (property_id, horizon_days, los, adults)
);
-- Colunas do modo 'fixed' e multi-tenant, idempotentes p/ bancos legados.
ALTER TABLE targets ADD COLUMN IF NOT EXISTS mode      TEXT NOT NULL DEFAULT 'rolling';
ALTER TABLE targets ADD COLUMN IF NOT EXISTS check_in  DATE;
ALTER TABLE targets ADD COLUMN IF NOT EXISTS check_out DATE;
ALTER TABLE targets ADD COLUMN IF NOT EXISTS auto_key  TEXT;
ALTER TABLE targets ADD COLUMN IF NOT EXISTS params    JSONB NOT NULL DEFAULT '{}';
ALTER TABLE targets ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE targets ALTER COLUMN horizon_days DROP NOT NULL;

-- Impede duplicar a mesma estadia fixa (nao afeta 'rolling').
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_fixed
  ON targets (property_id, check_in, check_out, adults)
  WHERE mode = 'fixed';

-- ─── Varreduras ──────────────────────────────────────────────────────────────
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
  message        TEXT,
  tenant_id      INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE scans ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS rates (
  id          BIGSERIAL PRIMARY KEY,
  scan_id     INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id   INTEGER REFERENCES targets(id) ON DELETE SET NULL,
  check_in    DATE NOT NULL,
  check_out   DATE NOT NULL,
  los         INTEGER NOT NULL,
  adults      INTEGER NOT NULL,
  price       NUMERIC(12,2) NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'BRL',
  source_raw  TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id   INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE rates ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_rates_scan     ON rates(scan_id);
CREATE INDEX IF NOT EXISTS idx_rates_lookup   ON rates(property_id, check_in, channel_id);
CREATE INDEX IF NOT EXISTS idx_rates_captured ON rates(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_rates_tenant   ON rates(tenant_id, property_id, check_in, channel_id);

CREATE TABLE IF NOT EXISTS findings (
  id            BIGSERIAL PRIMARY KEY,
  scan_id       INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  property_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  channel_id    INTEGER REFERENCES channels(id) ON DELETE CASCADE,  -- NULL p/ missing_direct
  target_id     INTEGER REFERENCES targets(id) ON DELETE SET NULL,
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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id     INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE
);
-- Bancos criados antes de missing_direct ainda tem channel_id NOT NULL.
ALTER TABLE findings ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_findings_scan    ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_open    ON findings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_channel ON findings(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_tenant  ON findings(tenant_id, status, created_at DESC);

-- ─── WhatsApp ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_recipients (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,           -- UNIQUE composta (tenant_id, phone) fica p/ o endurecimento
  jid        TEXT,
  is_group   BOOLEAN NOT NULL DEFAULT FALSE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id  INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE whatsapp_recipients ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  scan_id      INTEGER REFERENCES scans(id) ON DELETE SET NULL,
  recipient_id INTEGER REFERENCES whatsapp_recipients(id) ON DELETE SET NULL,
  phone        TEXT NOT NULL,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  tenant_id    INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

-- ─── Orcamento SerpAPI por mes ───────────────────────────────────────────────
-- PK (month) mantida na F1; migra p/ (tenant_id, connector_key, month) no
-- endurecimento (junto com o budget.js por-tenant). As colunas ja entram.
CREATE TABLE IF NOT EXISTS api_usage (
  month         TEXT PRIMARY KEY,
  used          INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id     INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
  connector_key TEXT NOT NULL DEFAULT 'hotel_serpapi'
);
ALTER TABLE api_usage ADD COLUMN IF NOT EXISTS tenant_id     INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE api_usage ADD COLUMN IF NOT EXISTS connector_key TEXT NOT NULL DEFAULT 'hotel_serpapi';

-- ─── Settings (PK (key) na F1; migra p/ (tenant_id, key) no endurecimento) ──
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id  INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE;

-- ─── Audit log (tenant_id/actor_id NULL p/ acoes de plataforma/superadmin) ──
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT,
  action     TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id  INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id  INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at DESC);

-- ─── Uniques/PKs compostas por tenant (multi-tenant real) ────────────────────
-- Um 2o tenant precisa dos PROPRIOS canais/settings/destinatarios sem colidir
-- com os do tenant #1. Trocamos as uniques globais por compostas com tenant_id.
-- Idempotente (DROP/ADD guardado). targets NAO precisa: property_id ja pertence
-- a um subject de um tenant, entao (property_id, ...) nao colide entre tenants.

-- channels: UNIQUE(slug) -> UNIQUE(tenant_id, slug)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_slug_key') THEN
    ALTER TABLE channels DROP CONSTRAINT channels_slug_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_tenant_slug_key') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_tenant_slug_key UNIQUE (tenant_id, slug);
  END IF;
END $$;

-- whatsapp_recipients: UNIQUE(phone) -> UNIQUE(tenant_id, phone) fica p/ o
-- endurecimento coordenado com o Nucleo (a rota POST /whatsapp/recipients usa
-- ON CONFLICT (phone) + scopeTenant; troca junto). uazapi nao configurado -> nao
-- bloqueia o demo. Por ora mantem UNIQUE(phone) global.

-- settings: PK(key) -> PK(tenant_id, key)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_pkey') THEN
    ALTER TABLE settings DROP CONSTRAINT settings_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_tenant_pkey') THEN
    ALTER TABLE settings ADD CONSTRAINT settings_tenant_pkey PRIMARY KEY (tenant_id, key);
  END IF;
END $$;

-- Alvo one-off do 'Ver os precos agora' (E6): entra numa varredura e NAO persiste
-- na lista de acompanhados (as listagens filtram WHERE NOT ephemeral; o scanner
-- desativa apos processar). 'Passar a acompanhar' = alvo normal (ephemeral=false).
ALTER TABLE targets ADD COLUMN IF NOT EXISTS ephemeral BOOLEAN NOT NULL DEFAULT FALSE;
