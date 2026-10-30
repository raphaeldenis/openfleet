DROP TABLE arbiter_decisions;
DROP TABLE plan_questions;
DROP TABLE plan_question_batches;
DROP TABLE escalations;
ALTER TABLE projects DROP COLUMN escalation_policy_json;
