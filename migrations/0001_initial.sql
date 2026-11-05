PRAGMA foreign_keys = ON;

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  version INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT
);
CREATE INDEX drafts_expiry ON drafts(expires_at);

CREATE TABLE recruitments (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT UNIQUE,
  owner_id TEXT NOT NULL,
  games_json TEXT NOT NULL CHECK(json_valid(games_json)),
  role_ids_json TEXT NOT NULL CHECK(json_valid(role_ids_json)),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK(ends_at > starts_at),
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  max_members INTEGER NOT NULL CHECK(max_members BETWEEN 1 AND 999),
  status TEXT NOT NULL CHECK(status IN ('publishing','open','cancelled','ended','publish_failed')),
  version INTEGER NOT NULL DEFAULT 0,
  synced_version INTEGER NOT NULL DEFAULT -1,
  next_reconcile_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX recruitments_expiry ON recruitments(status, ends_at);
CREATE INDEX recruitments_guild ON recruitments(guild_id, created_at);
CREATE INDEX recruitments_reconcile ON recruitments(next_reconcile_at);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  UNIQUE(recruitment_id, user_id)
);

CREATE TABLE interaction_receipts (
  interaction_id TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX receipts_expiry ON interaction_receipts(created_at);

CREATE TABLE message_jobs (
  recruitment_id TEXT PRIMARY KEY REFERENCES recruitments(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);
CREATE INDEX jobs_due ON message_jobs(blocked, next_attempt_at, lease_expires_at);

-- 모든 참가 경로에 DB 레벨 정원/상태 제약을 적용한다.
CREATE TRIGGER participant_guard BEFORE INSERT ON participants BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM recruitments r WHERE r.id = NEW.recruitment_id
      AND ((r.status = 'open' AND r.ends_at > unixepoch() * 1000)
        OR (r.status = 'publishing' AND r.owner_id = NEW.user_id))
      AND (SELECT COUNT(*) FROM participants p WHERE p.recruitment_id = r.id) < r.max_members
  ) THEN RAISE(ABORT, 'participant_guard') END;
END;

CREATE TRIGGER owner_guard BEFORE DELETE ON participants
WHEN EXISTS (SELECT 1 FROM recruitments r WHERE r.id = OLD.recruitment_id AND r.owner_id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'owner_is_fixed'); END;

CREATE TRIGGER participant_added AFTER INSERT ON participants BEGIN
  UPDATE recruitments SET version = version + 1, updated_at = unixepoch() * 1000 WHERE id = NEW.recruitment_id;
  INSERT INTO message_jobs(recruitment_id) VALUES (NEW.recruitment_id) ON CONFLICT(recruitment_id) DO NOTHING;
END;
CREATE TRIGGER participant_removed AFTER DELETE ON participants BEGIN
  UPDATE recruitments SET version = version + 1, updated_at = unixepoch() * 1000 WHERE id = OLD.recruitment_id;
  INSERT INTO message_jobs(recruitment_id) VALUES (OLD.recruitment_id) ON CONFLICT(recruitment_id) DO NOTHING;
END;
CREATE TRIGGER recruitment_status_changed AFTER UPDATE OF status ON recruitments
WHEN OLD.status != NEW.status BEGIN
  UPDATE recruitments SET version = version + 1, updated_at = unixepoch() * 1000 WHERE id = NEW.id;
  INSERT INTO message_jobs(recruitment_id) VALUES (NEW.id) ON CONFLICT(recruitment_id) DO NOTHING;
END;
