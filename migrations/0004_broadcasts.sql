-- ─────────────────────────────────────────────────────────────────
--  Bulk template broadcasts ("blast messages to N candidates")
--  Apply with: wrangler d1 migrations apply whatsapp_inbox_db
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS broadcasts (
    id            TEXT    PRIMARY KEY,
    template_name TEXT    NOT NULL,
    department    TEXT    NOT NULL,
    created_by    TEXT    REFERENCES agents(id),
    total         INTEGER NOT NULL DEFAULT 0,
    sent_count    INTEGER NOT NULL DEFAULT 0,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
    id              TEXT    PRIMARY KEY,
    broadcast_id    TEXT    NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    phone           TEXT    NOT NULL,
    name            TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
    error           TEXT,
    conversation_id TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_bid ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_department     ON broadcasts(department);
