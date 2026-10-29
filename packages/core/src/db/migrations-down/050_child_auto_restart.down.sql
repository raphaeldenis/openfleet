DROP INDEX child_restarts_by_session;
DROP TABLE child_restarts;
ALTER TABLE managers DROP COLUMN child_auto_restart;
