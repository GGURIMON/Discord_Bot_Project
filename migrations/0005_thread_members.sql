CREATE TABLE thread_join_jobs (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  next_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX thread_join_due ON thread_join_jobs(next_at);
CREATE TRIGGER queue_thread_member AFTER INSERT ON participants BEGIN
  INSERT INTO thread_join_jobs(participant_id) VALUES(NEW.id);
END;
