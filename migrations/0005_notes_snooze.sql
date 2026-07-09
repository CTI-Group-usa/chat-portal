-- ─────────────────────────────────────────────────────────────────
--  Internal notes + conversation snoozing
--  Apply with: wrangler d1 migrations apply whatsapp_inbox_db
-- ─────────────────────────────────────────────────────────────────

-- Internal notes are agent-to-agent only — never sent to the candidate via WhatsApp.
ALTER TABLE messages ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0;

-- NULL = not snoozed. A future timestamp hides the conversation from normal
-- queues until then (or until the candidate messages again, which clears it).
ALTER TABLE conversations ADD COLUMN snoozed_until TEXT;
