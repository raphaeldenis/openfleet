ALTER TABLE escalations ADD COLUMN handover_refusal_json TEXT CHECK(handover_refusal_json IS NULL OR (json_valid(handover_refusal_json) AND json_type(handover_refusal_json) = 'object'));
