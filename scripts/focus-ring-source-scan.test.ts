import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP_SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/desktop/src');
const RING_AND_SHADOW_DECLARATION = /(?:outline(?:-offset)?|box-shadow)\s*:[^;}]*/g;
const PIXEL_VALUE_BEYOND_HAIRLINE = /(?<![\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px/;
const EXTERNAL_STYLESHEET = /\bstyleUrls?\s*:/;

function pixelRingDeclarationsIn(source: string): string[] {
  const declarations = source.match(RING_AND_SHADOW_DECLARATION) ?? [];
  return declarations.filter((declaration) => PIXEL_VALUE_BEYOND_HAIRLINE.test(declaration));
}

function componentSources(): { path: string; source: string }[] {
  const relativePaths = readdirSync(DESKTOP_SOURCE_ROOT, { recursive: true, encoding: 'utf8' });
  return relativePaths
    .filter((relativePath) => relativePath.endsWith('.component.ts'))
    .map((relativePath) => ({ path: relativePath, source: readFileSync(join(DESKTOP_SOURCE_ROOT, relativePath), 'utf8') }));
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

  it('accepts rings in rem and one pixel hairlines', () => {
    const source = '.tab:focus-visible { outline: .125rem solid var(--accent) } .chip { box-shadow: inset 0 0 0 1px var(--line) }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });
});

describe('the desktop component sources', () => {
  const components = componentSources();

  it('lists the components it scans', () => {
    expect(components.length).toBeGreaterThan(50);
  });

  it('size every outline, outline offset and box-shadow in rem', () => {
    const pixelRings = components.flatMap(({ path, source }) => pixelRingDeclarationsIn(source).map((declaration) => `${path}: ${declaration.trim()}`));

    expect(pixelRings).toEqual([]);
  });

  it('ship their styles inline, where the scan and the unit spec can read them', () => {
    const componentsWithExternalStylesheet = components.filter(({ source }) => EXTERNAL_STYLESHEET.test(source)).map(({ path }) => path);

    expect(componentsWithExternalStylesheet).toEqual([]);
  });
});
