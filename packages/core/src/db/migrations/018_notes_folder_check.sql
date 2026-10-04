-- notes.folder accepts only the NOTE_FOLDERS of @openfleet/shared (specs, plans, handoffs, reports) or NULL (unfiled).
-- Triggers rather than a table rebuild: dropping notes inside the runner's transaction would cascade-delete note_versions.
UPDATE notes SET folder = NULL WHERE folder IS NOT NULL AND folder NOT IN ('specs', 'plans', 'handoffs', 'reports');

CREATE TRIGGER notes_folder_valid_on_insert BEFORE INSERT ON notes
WHEN new.folder IS NOT NULL AND new.folder NOT IN ('specs', 'plans', 'handoffs', 'reports') BEGIN
  SELECT RAISE(ABORT, 'notes.folder must be NULL or one of specs, plans, handoffs, reports');
END;

CREATE TRIGGER notes_folder_valid_on_update BEFORE UPDATE OF folder ON notes
WHEN new.folder IS NOT NULL AND new.folder NOT IN ('specs', 'plans', 'handoffs', 'reports') BEGIN
  SELECT RAISE(ABORT, 'notes.folder must be NULL or one of specs, plans, handoffs, reports');
END;
