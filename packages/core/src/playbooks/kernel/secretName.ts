/** The name a playbook declares for a secret; it is written inside `{{secret:NAME}}` and `[secret:NAME]`, so it holds no brace, bracket, space or colon. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
