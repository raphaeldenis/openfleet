import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP_SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/desktop/src');
const OUTLINE_SHADOW_AND_RING_PROPERTY_DECLARATION =
  /(?:outline(?:-width|-offset)?|box-shadow|--(?:[\w-]*-)?(?:ring|focus)[\w-]*)\s*:[^;}]*|filter\s*:[^;}]*drop-shadow[^;}]*/gi;
const RULE_WITH_FOCUS_SELECTOR = /[^{}]*:focus\b[^{}]*\{([^{}]*)\}/g;
const BORDER_DECLARATION = /border(?:-(?:top|right|bottom|left|inline|block))?(?:-width)?\s*:[^;}]*/g;
const PIXEL_VALUE_BEYOND_HAIRLINE = /(?<![\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px/i;
const EXTERNAL_STYLESHEET = /\bstyleUrls?\s*:/;

function borderRingDeclarationsIn(source: string): string[] {
  const focusRuleBodies = [...source.matchAll(RULE_WITH_FOCUS_SELECTOR)].map(([, body]) => body ?? '');
  return focusRuleBodies.flatMap((body) => body.match(BORDER_DECLARATION) ?? []);
}

function pixelRingDeclarationsIn(source: string): string[] {
  const declarations = source.match(OUTLINE_SHADOW_AND_RING_PROPERTY_DECLARATION) ?? [];
  const candidates = [...declarations, ...borderRingDeclarationsIn(source)];
  return candidates.filter((declaration) => PIXEL_VALUE_BEYOND_HAIRLINE.test(declaration));
}

interface StyleSource {
  path: string;
  source: string;
}

interface ElevationShadowAllowance {
  path: string;
  declaration: string;
  name: string;
}

const ELEVATION_SHADOW_ALLOWED: ElevationShadowAllowance[] = [];

function unallowedPixelRingsIn({
  path,
  source,
  allowlist = ELEVATION_SHADOW_ALLOWED,
}: StyleSource & { allowlist?: ElevationShadowAllowance[] }): string[] {
  const isAllowedElevation = (declaration: string) =>
    allowlist.some((allowance) => allowance.path === path && allowance.declaration === declaration.trim());
  return pixelRingDeclarationsIn(source).filter((declaration) => !isAllowedElevation(declaration));
}

function sourcesEndingWith(suffix: string): StyleSource[] {
  const relativePaths = readdirSync(DESKTOP_SOURCE_ROOT, { recursive: true, encoding: 'utf8' });
  return relativePaths
    .filter((relativePath) => relativePath.endsWith(suffix))
    .map((relativePath) => ({ path: relativePath, source: readFileSync(join(DESKTOP_SOURCE_ROOT, relativePath), 'utf8') }));
}

function componentSources(): StyleSource[] {
  return sourcesEndingWith('.component.ts');
}

function globalStylesheetSources(): StyleSource[] {
  return sourcesEndingWith('.scss');
}

describe('the pixel ring detector', () => {
  it('flags a focus-visible outline sized in pixels', () => {
    const source = '.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline: 2px solid var(--accent)', 'outline-offset: -2px ']);
  });

  it('flags a has-focus-visible box-shadow ring sized in pixels', () => {
    const source = '.mode:has(input:focus-visible) { box-shadow: 0 0 0 3px var(--accent) }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['box-shadow: 0 0 0 3px var(--accent) ']);
  });

  it('flags a persistent selection bar sized in pixels', () => {
    const source = ".row[aria-current='true'] { box-shadow: inset 2px 0 0 var(--accent) }";

    expect(pixelRingDeclarationsIn(source)).toEqual(['box-shadow: inset 2px 0 0 var(--accent) ']);
  });

  it('flags an outline-width sized in pixels', () => {
    const source = '.tab:focus-visible { outline-width: 2px }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline-width: 2px ']);
  });

  it('flags a drop-shadow filter ring sized in pixels', () => {
    const source = '.tab:focus-visible { filter: drop-shadow(0 0 2px var(--accent)) }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['filter: drop-shadow(0 0 2px var(--accent)) ']);
  });

  it('flags an uppercase PX unit', () => {
    const source = '.tab:focus-visible { outline: 2PX solid var(--accent) }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline: 2PX solid var(--accent) ']);
  });

  it.each([
    ['--ring', '.tab { --ring: 2px }', '--ring: 2px '],
    ['--focus-width', '.tab { --focus-width: 3px }', '--focus-width: 3px '],
    ['--tab-ring-size', '.tab { --tab-ring-size: 2px }', '--tab-ring-size: 2px '],
  ])('flags the %s custom property sized in pixels', (_name, source, declaration) => {
    expect(pixelRingDeclarationsIn(source)).toEqual([declaration]);
  });

  it.each([
    ['focus-visible', '.tab:focus-visible { border: 2px solid var(--accent) }'],
    ['focus-within', '.field:focus-within { border: 2px solid var(--accent) }'],
    ['has focus-visible', '.mode:has(input:focus-visible) { border-width: 2px }'],
  ])('flags a pixel border used as a %s ring', (_name, source) => {
    expect(pixelRingDeclarationsIn(source)).toHaveLength(1);
  });

  it('accepts a pixel border outside a focus rule', () => {
    const source = '.card { border: 2px solid var(--line) } .tab:focus-visible { outline: .125rem solid var(--accent) }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('accepts a one pixel border inside a focus rule', () => {
    const source = '.tab:focus-visible { border: 1px solid var(--accent) }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('accepts unrelated custom properties and rem custom property rings', () => {
    const source = '.tab { --gap: 8px; --ring: .125rem; --focus-width: 0.125rem }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('accepts rings in rem and one pixel hairlines', () => {
    const source = '.tab:focus-visible { outline: .125rem solid var(--accent) } .chip { box-shadow: inset 0 0 0 1px var(--line) }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });
});

describe('the elevation shadow allowlist', () => {
  const allowlist = [{ path: 'ui/card.component.ts', declaration: 'box-shadow: 0 4px 12px rgba(0, 0, 0, .2)', name: 'card elevation' }];

  it('allows a named elevation shadow in its own file', () => {
    const source = '.card { box-shadow: 0 4px 12px rgba(0, 0, 0, .2) }';

    expect(unallowedPixelRingsIn({ path: 'ui/card.component.ts', source, allowlist })).toEqual([]);
  });

  it('flags the same shadow in another file', () => {
    const source = '.card { box-shadow: 0 4px 12px rgba(0, 0, 0, .2) }';

    expect(unallowedPixelRingsIn({ path: 'ui/tab.component.ts', source, allowlist })).toEqual(['box-shadow: 0 4px 12px rgba(0, 0, 0, .2) ']);
  });

  it('flags another shadow in the allowed file', () => {
    const source = '.card:focus-visible { box-shadow: 0 0 0 3px var(--accent) }';

    expect(unallowedPixelRingsIn({ path: 'ui/card.component.ts', source, allowlist })).toEqual(['box-shadow: 0 0 0 3px var(--accent) ']);
  });

  it('is empty on the current sources', () => {
    expect(ELEVATION_SHADOW_ALLOWED).toEqual([]);
  });
});

describe('the desktop component sources', () => {
  const components = componentSources();
  const globalStylesheets = globalStylesheetSources();

  it('lists the components it scans', () => {
    expect(components.length).toBeGreaterThan(50);
  });

  it('lists the global stylesheets it scans', () => {
    expect(globalStylesheets.map(({ path }) => path)).toContain('styles.scss');
  });

  it('size every outline, outline offset, box-shadow, drop-shadow and ring property in rem', () => {
    const pixelRings = [...components, ...globalStylesheets].flatMap(({ path, source }) =>
      unallowedPixelRingsIn({ path, source }).map((declaration) => `${path}: ${declaration.trim()}`),
    );

    expect(pixelRings).toEqual([]);
  });

  it('ship their styles inline, where the scan and the unit spec can read them', () => {
    const componentsWithExternalStylesheet = components.filter(({ source }) => EXTERNAL_STYLESHEET.test(source)).map(({ path }) => path);

    expect(componentsWithExternalStylesheet).toEqual([]);
  });
});
