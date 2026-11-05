DROP TRIGGER reschedule_reminder;
CREATE TRIGGER reschedule_reminder AFTER UPDATE OF starts_at,time_label ON recruitments
WHEN OLD.starts_at!=NEW.starts_at OR COALESCE(OLD.time_label GLOB '[0-2][0-9]:[0-5][0-9]*',0) != COALESCE(NEW.time_label GLOB '[0-2][0-9]:[0-5][0-9]*',0)
BEGIN
  DELETE FROM start_reminders WHERE recruitment_id=NEW.id AND sent_at IS NULL AND position=0 AND first_send_at IS NULL;
  INSERT OR IGNORE INTO start_reminders(recruitment_id,due_at,next_at)
    SELECT NEW.id,NEW.starts_at-600000,NEW.starts_at-600000
    WHERE NEW.time_label GLOB '[0-2][0-9]:[0-5][0-9]*' AND NEW.starts_at-600000>=unixepoch('subsec')*1000;
END;
