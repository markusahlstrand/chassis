-- The staff roster (#42): which humans may act on the control plane, and under
-- which PlatformActorId the admin log records them.
--
-- Before this, every rostered email mapped to ONE hardcoded actor, so suspend,
-- archive and entitlement changes were indistinguishable between operators — the
-- admin log could not do the job §4.4 exists for. Access also lived in a
-- comma-separated env var, so "who has platform access" was not a question the
-- system could answer, and revoking it meant a secret update.
--
-- Revocation TOMBSTONES rather than deletes, following K-21: a row that once
-- granted access is the evidence of why an action was permitted, and D-32's
-- operated compliance product has to produce exactly that.

CREATE TABLE IF NOT EXISTS staff_actor (
  email      TEXT PRIMARY KEY,  -- lowercased at the boundary
  actor      TEXT NOT NULL,     -- PlatformActorId (ULID), stable for this human forever
  name       TEXT,
  added_at   TEXT NOT NULL,
  revoked_at TEXT               -- non-null = access withdrawn, row kept as evidence
);

-- Bootstrap. This ULID is the actor every existing `_substrat_admin_log` row was
-- written under, so binding it to the sole operator makes that history correctly
-- attributed rather than merely guessed.
--
-- That is true ONLY IF this deployment ever had one operator — which it did:
-- STAFF_EMAILS defaulted to this address and no second entry was configured. If
-- your deployment ever carried more than one email, prior rows are genuinely
-- ambiguous: drop this INSERT and treat pre-migration history as unattributed.
INSERT OR IGNORE INTO staff_actor (email, actor, name, added_at)
VALUES ('markus@substrat.run', '01JZ00000000000000000000MK', 'Markus', datetime('now'));
