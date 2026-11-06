ALTER TABLE recruitments ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recruitments ADD COLUMN creator_id TEXT;
UPDATE recruitments SET creator_id=owner_id;
ALTER TABLE recruitments ADD COLUMN changes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE drafts ADD COLUMN edit_id TEXT;
CREATE TABLE waiting (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
 user_id TEXT NOT NULL,
 promoted INTEGER NOT NULL DEFAULT 0,
 UNIQUE(recruitment_id,user_id)
);
CREATE TABLE transfers (
 id TEXT PRIMARY KEY,
 recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
 from_user TEXT NOT NULL,
 to_user TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX recruitment_creator ON recruitments(guild_id,creator_id,created_at);
CREATE TRIGGER management_changed AFTER UPDATE OF completed,owner_id,games_json,role_ids_json,starts_at,ends_at,max_members ON recruitments BEGIN
 UPDATE recruitments SET version=version+1,updated_at=unixepoch()*1000 WHERE id=NEW.id;
 INSERT INTO message_jobs(recruitment_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER completed_guard BEFORE INSERT ON participants
WHEN EXISTS(SELECT 1 FROM recruitments WHERE id=NEW.recruitment_id AND completed=1)
BEGIN SELECT RAISE(ABORT,'completed'); END;
