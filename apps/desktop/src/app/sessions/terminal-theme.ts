import type { ITheme } from '@xterm/xterm';

/** Builds the xterm theme from the `--term-*` design tokens of the theme currently on the document. */
export function terminalThemeFromTokens(): ITheme {
  const tokens = getComputedStyle(document.documentElement);
  const background = tokens.getPropertyValue('--term-bg').trim();
  const foreground = tokens.getPropertyValue('--term-fg').trim();
  return { background, foreground, cursor: foreground, cursorAccent: background };
}
