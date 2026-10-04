import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'openfleet.theme';
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function readRememberedTheme(): unknown {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is unavailable: the theme still switches, it just is not remembered.
  }
}

function systemTheme(): Theme {
  const prefersDark = typeof matchMedia === 'function' && matchMedia(DARK_SCHEME_QUERY).matches;
  return prefersDark ? 'dark' : 'light';
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/** Owns the light/dark choice: restores it (or the system preference) and mirrors it on `:root[data-theme]`. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly current = signal<Theme>(this.initialTheme());
  readonly theme = this.current.asReadonly();

  constructor() {
    this.applyToDocument(this.current());
  }

  toggle(): void {
    const next = otherTheme(this.current());
    this.current.set(next);
    this.applyToDocument(next);
    rememberTheme(next);
  }

  private initialTheme(): Theme {
    const remembered = readRememberedTheme();
    return isTheme(remembered) ? remembered : systemTheme();
  }

  private applyToDocument(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
