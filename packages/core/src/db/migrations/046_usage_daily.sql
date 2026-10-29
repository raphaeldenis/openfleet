CREATE TABLE usage_messages (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  model TEXT NOT NULL,
  billing_code TEXT NOT NULL,
  biller TEXT NOT NULL CHECK (biller IN ('subscription', 'api')),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_input_tokens INTEGER NOT NULL CHECK (cache_read_input_tokens >= 0),
  cache_creation_input_tokens INTEGER NOT NULL CHECK (cache_creation_input_tokens >= 0),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'unpriced')),
  PRIMARY KEY (session_id, message_id)
) STRICT;

CREATE TABLE usage_daily (
  day_utc TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT NOT NULL,
  billing_code TEXT NOT NULL,
  biller TEXT NOT NULL CHECK (biller IN ('subscription', 'api')),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'unpriced')),
  message_count INTEGER NOT NULL CHECK (message_count > 0),
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cost_usd REAL,
  PRIMARY KEY (day_utc, model, session_id, billing_code, biller, cost_status)
) STRICT;
CREATE INDEX usage_daily_billing_code ON usage_daily(billing_code, day_utc);
