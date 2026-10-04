/** Styles shared by the settings pages: the bordered card of rows, and the value shown at the right of a row (read-only text or a button, 8rem at least, mono for paths and ids). */
export const SETTINGS_VALUE_STYLES = `
  .rows { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
  .value { height: 1.75rem; min-width: 8rem; display: inline-flex; align-items: center; padding: 0 .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); color: var(--fg); font: inherit; font-size: .75rem; text-align: left; }
  button.value { cursor: pointer; }
  button.value:disabled { cursor: not-allowed; color: var(--mut); }
  button.value:focus-visible { outline: 2px solid var(--accent); outline-offset: .125rem; }
  .mono { font-family: var(--mono); }
  .hint { margin: 0; font-size: .75rem; color: var(--mut); }
  .error { margin: 0; color: var(--state-error); }
`;
