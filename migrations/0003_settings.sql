-- ─────────────────────────────────────────────────────────────────
--  Runtime-editable settings (business hours, etc.) — key/value store
--  Apply with: wrangler d1 migrations apply whatsapp_inbox_db
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
