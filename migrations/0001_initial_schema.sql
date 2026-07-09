-- ─────────────────────────────────────────────────────────────────
--  WhatsApp Shared Inbox — Initial Schema
--  Apply with: wrangler d1 migrations apply whatsapp_inbox_db
-- ─────────────────────────────────────────────────────────────────

-- Agents / internal recruiters
CREATE TABLE IF NOT EXISTS agents (
    id            TEXT    PRIMARY KEY,          -- UUID v4
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,             -- bcrypt hash
    role          TEXT    NOT NULL DEFAULT 'recruiter', -- recruiter | admin
    is_active     INTEGER NOT NULL DEFAULT 1,   -- 1 = active
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One conversation per candidate phone number
CREATE TABLE IF NOT EXISTS conversations (
    id                        TEXT    PRIMARY KEY,
    candidate_phone           TEXT    NOT NULL UNIQUE,   -- E.164 without +  e.g. 628123456789
    candidate_name            TEXT,
    assigned_agent_id         TEXT    REFERENCES agents(id),
    status                    TEXT    NOT NULL DEFAULT 'open', -- open | resolved | pending
    last_candidate_message_at TEXT,                           -- ISO8601 — drives 24-h window
    created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_agent  ON conversations(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conv_phone  ON conversations(candidate_phone);

-- Individual message rows
CREATE TABLE IF NOT EXISTS messages (
    id               TEXT    PRIMARY KEY,
    conversation_id  TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type      TEXT    NOT NULL CHECK(sender_type IN ('agent','candidate','system')),
    agent_id         TEXT    REFERENCES agents(id),
    body_text        TEXT,
    media_url        TEXT,
    media_type       TEXT,                   -- image | document | audio | video
    meta_message_id  TEXT    UNIQUE,         -- wamid.xxx from Graph API response
    status           TEXT    NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','sent','delivered','read','failed')),
    template_name    TEXT,                   -- populated for template sends
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_msg_conv    ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_meta_id ON messages(meta_message_id);

-- Approved Meta message templates (local cache)
CREATE TABLE IF NOT EXISTS message_templates (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE,   -- must match Meta-approved template name exactly
    language_code TEXT    NOT NULL DEFAULT 'en_US',
    category      TEXT    NOT NULL DEFAULT 'UTILITY', -- AUTHENTICATION | MARKETING | UTILITY
    header_text   TEXT,
    body_text     TEXT    NOT NULL,           -- raw body with {{1}} {{2}} placeholders
    footer_text   TEXT,
    variables     TEXT    NOT NULL DEFAULT '[]', -- JSON: [{"key":"1","label":"candidate_name"}]
    is_active     INTEGER NOT NULL DEFAULT 1
);

-- Seed: default admin agent (password: Admin@1234  — change immediately after first login)
-- bcrypt hash of "Admin@1234" with cost 10
INSERT OR IGNORE INTO agents (id, name, email, password_hash, role)
VALUES (
    'agt-00000000-0000-0000-0000-000000000001',
    'System Admin',
    'CTI-IT-Team@cti-usa.com',
    '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lHHG',
    'admin'
);

-- Seed: sample approved templates
INSERT OR IGNORE INTO message_templates (id, name, language_code, category, header_text, body_text, footer_text, variables)
VALUES
(
    'tpl-00000000-0000-0000-0000-000000000001',
    'interview_invitation',
    'en_US',
    'UTILITY',
    'Interview Invitation — CTI Group',
    'Dear {{1}}, we are pleased to invite you to an interview for the position you applied for. The interview is scheduled on {{2}} via {{3}}. Please confirm your availability by replying to this message.',
    'CTI Group Worldwide Services Inc.',
    '[{"key":"1","label":"Candidate Name"},{"key":"2","label":"Schedule (Date & Time)"},{"key":"3","label":"Platform (e.g. Google Meet)"}]'
),
(
    'tpl-00000000-0000-0000-0000-000000000002',
    'application_update',
    'en_US',
    'UTILITY',
    NULL,
    'Hi {{1}}, this is an update regarding your application with CTI Group. {{2}}. For inquiries, please reply directly to this message.',
    'CTI Group Worldwide Services Inc.',
    '[{"key":"1","label":"Candidate Name"},{"key":"2","label":"Update Details"}]'
),
(
    'tpl-00000000-0000-0000-0000-000000000003',
    'document_request',
    'en_US',
    'UTILITY',
    NULL,
    'Hello {{1}}, to proceed with your application, please send us the following document(s): {{2}}. Kindly submit within {{3}} business days.',
    'CTI Group Worldwide Services Inc.',
    '[{"key":"1","label":"Candidate Name"},{"key":"2","label":"Document List"},{"key":"3","label":"Days"}]'
);
