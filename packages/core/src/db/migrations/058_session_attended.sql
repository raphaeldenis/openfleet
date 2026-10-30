ALTER TABLE sessions ADD COLUMN attended INTEGER NOT NULL DEFAULT 0 CHECK(attended IN (0, 1));

CREATE TRIGGER sessions_attended_is_fixed_at_creation BEFORE UPDATE OF attended ON sessions
WHEN new.attended IS NOT old.attended BEGIN
  SELECT RAISE(ABORT, 'sessions.attended is fixed at creation');
END;
