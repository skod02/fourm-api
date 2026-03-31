-- ============================================================
-- Forum API — D1 Schema
-- Migration: 0001_initial
-- ============================================================

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,                   -- UUID v4
  username     TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                     -- PBKDF2-SHA256
  role         TEXT NOT NULL DEFAULT 'user'
                 CHECK(role IN ('guest','user','mod','admin')),
  is_vip       INTEGER NOT NULL DEFAULT 0,
  is_banned    INTEGER NOT NULL DEFAULT 0,
  reputation   INTEGER NOT NULL DEFAULT 0,
  api_secret_hash TEXT,                            -- SHA-256 of raw secret
  vip_key      TEXT,                               -- nullable, set on VIP approval
  username_changes INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role);

-- ============================================================
-- SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,                   -- SHA-256 of raw session token
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip           TEXT NOT NULL,
  user_agent   TEXT,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================
-- LOGIN HISTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS login_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip           TEXT NOT NULL,
  user_agent   TEXT,
  success      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_history_user_id ON login_history(user_id);

-- ============================================================
-- THREADS
-- ============================================================
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,               -- UUID v4
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  author_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section         TEXT NOT NULL DEFAULT 'general',
  vip_only        INTEGER NOT NULL DEFAULT 0,
  is_announcement INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','removed','locked')),
  view_count      INTEGER NOT NULL DEFAULT 0,
  reply_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_author_id       ON threads(author_id);
CREATE INDEX IF NOT EXISTS idx_threads_section         ON threads(section);
CREATE INDEX IF NOT EXISTS idx_threads_status          ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_is_announcement ON threads(is_announcement);
CREATE INDEX IF NOT EXISTS idx_threads_created_at      ON threads(created_at DESC);

-- ============================================================
-- REPLIES
-- ============================================================
CREATE TABLE IF NOT EXISTS replies (
  id           TEXT PRIMARY KEY,                   -- UUID v4
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id    TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  content      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK(status IN ('active','removed')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replies_thread_id ON replies(thread_id);
CREATE INDEX IF NOT EXISTS idx_replies_author_id ON replies(author_id);
CREATE INDEX IF NOT EXISTS idx_replies_created_at ON replies(created_at);

-- ============================================================
-- APPS (Developer applications using the licensing system)
-- ============================================================
CREATE TABLE IF NOT EXISTS apps (
  id               TEXT PRIMARY KEY,               -- UUID v4
  owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  webhook_url      TEXT,                            -- Admin push notifications
  api_secret_hash  TEXT NOT NULL,                  -- X-API-Secret auth
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_owner_id ON apps(owner_id);

-- ============================================================
-- LICENSE KEYS
-- ============================================================
CREATE TABLE IF NOT EXISTS license_keys (
  key           TEXT PRIMARY KEY,                  -- XXXX-XXXX-XXXX-XXXX-XXXX
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'valid'
                  CHECK(status IN ('valid','expired','banned','maxed')),
  max_devices   INTEGER NOT NULL DEFAULT 1,
  device_ids    TEXT NOT NULL DEFAULT '[]',        -- JSON array of HWIDs
  usage_count   INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER,                           -- nullable = no expiry
  last_used_at  INTEGER,
  last_ip       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_keys_app_id    ON license_keys(app_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_status    ON license_keys(status);
CREATE INDEX IF NOT EXISTS idx_license_keys_expires_at ON license_keys(expires_at);

-- ============================================================
-- KEY USAGE LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS key_usage_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id       TEXT NOT NULL REFERENCES license_keys(key) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  ip           TEXT NOT NULL,
  action       TEXT NOT NULL DEFAULT 'validate',  -- validate | bind | rebind
  ts           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_key_usage_logs_key_id ON key_usage_logs(key_id);
CREATE INDEX IF NOT EXISTS idx_key_usage_logs_ts     ON key_usage_logs(ts DESC);

-- ============================================================
-- LISTINGS (Marketplace)
-- ============================================================
CREATE TABLE IF NOT EXISTS listings (
  id           TEXT PRIMARY KEY,                   -- UUID v4
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  seller_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category     TEXT NOT NULL DEFAULT 'tools',
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','active','removed')),
  vip_required INTEGER NOT NULL DEFAULT 0,
  price        REAL,                               -- NULL = free
  download_url TEXT,                               -- R2 presigned or external
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_seller_id  ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_category   ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_status     ON listings(status);

-- ============================================================
-- MESSAGES (Inbox)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,                   -- UUID v4
  from_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_to_id      ON messages(to_id);
CREATE INDEX IF NOT EXISTS idx_messages_from_id    ON messages(from_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

-- ============================================================
-- REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,                   -- UUID v4
  reporter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK(target_type IN ('thread','reply','listing','user')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK(status IN ('open','resolved','dismissed')),
  resolved_by  TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_reporter_id ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_status      ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_target_id   ON reports(target_id);

-- ============================================================
-- DMCA REQUESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS dmca_requests (
  id                  TEXT PRIMARY KEY,            -- UUID v4
  requester_name      TEXT NOT NULL,
  requester_email     TEXT NOT NULL,
  target_type         TEXT NOT NULL,
  target_id           TEXT NOT NULL,
  description         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','under_review','upheld','dismissed')),
  workflow_instance_id TEXT,                       -- Workflows instance tracking
  resolved_by         TEXT REFERENCES users(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dmca_requests_status ON dmca_requests(status);

-- ============================================================
-- VIP REQUESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS vip_requests (
  id                  TEXT PRIMARY KEY,            -- UUID v4
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','approved','denied')),
  reason              TEXT,
  workflow_instance_id TEXT,
  reviewed_by         TEXT REFERENCES users(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vip_requests_user_id ON vip_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_vip_requests_status  ON vip_requests(status);

-- ============================================================
-- ANNOUNCEMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS announcements (
  id           TEXT PRIMARY KEY,                   -- UUID v4
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  author_id    TEXT NOT NULL REFERENCES users(id),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active);

-- ============================================================
-- TURNSTILE FRAUD SIGNALS (Ephemeral ID tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS fraud_signals (
  ephemeral_id TEXT PRIMARY KEY,                   -- Turnstile ephemeral ID
  action_count INTEGER NOT NULL DEFAULT 1,
  last_ip      TEXT,
  blocked      INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_blocked ON fraud_signals(blocked);
