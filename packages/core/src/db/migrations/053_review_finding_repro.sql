ALTER TABLE review_finding_items ADD COLUMN repro_status TEXT CHECK (repro_status IN ('proven', 'plausible', 'not_reproduced'));
ALTER TABLE review_finding_items ADD COLUMN repro_command TEXT;
ALTER TABLE review_finding_items ADD COLUMN repro_output TEXT;
