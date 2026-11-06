CREATE TABLE start_reminders (
  recruitment_id TEXT PRIMARY KEY REFERENCES recruitments(id),
  due_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  thread_id TEXT,
  claim TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  recipients TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  first_send_at INTEGER,
  sent_at INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reminders_ready ON start_reminders(next_at) WHERE blocked=0 AND sent_at IS NULL;
CREATE TRIGGER schedule_new_reminder AFTER INSERT ON recruitments
WHEN NEW.time_label GLOB '[0-2][0-9]:[0-5][0-9]*' AND NEW.starts_at-NEW.created_at>=600000
BEGIN
  INSERT INTO start_reminders(recruitment_id,due_at,next_at) VALUES(NEW.id,NEW.starts_at-600000,NEW.starts_at-600000);
END;
CREATE TRIGGER reschedule_reminder AFTER UPDATE OF starts_at,time_label ON recruitments
WHEN OLD.starts_at!=NEW.starts_at OR OLD.time_label IS NOT NEW.time_label
BEGIN
  DELETE FROM start_reminders WHERE recruitment_id=NEW.id AND sent_at IS NULL AND position=0 AND first_send_at IS NULL;
  INSERT OR IGNORE INTO start_reminders(recruitment_id,due_at,next_at)
    SELECT NEW.id,NEW.starts_at-600000,NEW.starts_at-600000
    WHERE NEW.time_label GLOB '[0-2][0-9]:[0-5][0-9]*' AND NEW.starts_at-600000>=unixepoch('subsec')*1000;
END;
INSERT INTO start_reminders(recruitment_id,due_at,next_at)
  SELECT id,starts_at-600000,starts_at-600000 FROM recruitments
  WHERE status='open' AND typeof(starts_at)='integer' AND starts_at-600000>=unixepoch()*1000
    AND starts_at-created_at>=600000 AND time_label GLOB '[0-2][0-9]:[0-5][0-9]*'
    AND substr(time_label,1,5)=strftime('%H:%M',starts_at/1000,'unixepoch','+9 hours');
