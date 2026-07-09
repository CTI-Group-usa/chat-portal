-- ─────────────────────────────────────────────────────────────────
--  AI Routing — department-based auto-routing + after-hours agent
--  Apply with: wrangler d1 migrations apply whatsapp_inbox_db
-- ─────────────────────────────────────────────────────────────────

-- Which team an agent belongs to. Admins see every department regardless.
ALTER TABLE agents ADD COLUMN department TEXT NOT NULL DEFAULT 'business';

-- Department the conversation was auto-routed to, and how confident the AI was.
ALTER TABLE conversations ADD COLUMN department TEXT;
ALTER TABLE conversations ADD COLUMN intent_confidence REAL;

-- Marks a message as an after-hours AI auto-reply rather than a human agent reply.
ALTER TABLE messages ADD COLUMN is_ai_generated INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conv_department ON conversations(department);
CREATE INDEX IF NOT EXISTS idx_agent_department ON agents(department);
