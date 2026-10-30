import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP_SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/desktop/src');
const RING_PROPERTY_NAME = String.raw`outline(?:-width|-offset)?|box-shadow|--(?:[\w-]*-)?(?:ring|focus)[\w-]*`;
const OUTLINE_SHADOW_AND_RING_PROPERTY_DECLARATION = new RegExp(
  String.raw`(?:${RING_PROPERTY_NAME})\s*:[^;}]*|filter\s*:[^;}]*drop-shadow[^;}]*`,
  'gi',
);
const BORDER_DECLARATION = /(?<![\w-])border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-width)?\s*:[^;}]*/g;
const PIXEL_VALUE_BEYOND_HAIRLINE = /(?<![\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px/i;
const EXTERNAL_STYLESHEET = /\bstyleUrls?\s*:/;
const CSS_COMMENT = /\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g;
const FOCUS_PSEUDO_CLASS = /:focus\b/;
const NEGATION_WITHOUT_NESTED_PARENTHESES = /:not\([^()]*\)/g;
const INLINE_STYLE_ATTRIBUTE = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/g;
const INLINE_STYLE_BINDING = new RegExp(
  String.raw`\[style\.(${RING_PROPERTY_NAME}|filter)(\.px)?\]\s*=\s*(["'])([\s\S]*?)\3`,
  'gi',
);
const STYLES_PROPERTY_LITERALS = /\bstyles\s*:\s*(?:\[\s*)?((?:`[^`]*`\s*,?\s*)+)/g;
const TEMPLATE_LITERAL = /`([^`]*)`/g;
const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

interface PixelRing {
  selector: string;
  declaration: string;
}

interface CssRule {
  selector: string;
  body: string;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function splitIntoStatementsAndRules(css: string): { statements: string[]; rules: CssRule[] } {
  const statements: string[] = [];
  const rules: CssRule[] = [];
  let pending = '';
  let selector = '';
  let body = '';
  let depth = 0;
  for (const character of css) {
    const opensBlock = character === '{';
    const closesBlock = character === '}' && depth > 0;
    if (opensBlock && depth === 0) {
      selector = pending;
      pending = '';
      body = '';
    } else if (closesBlock && depth === 1) {
      rules.push({ selector: collapseWhitespace(selector), body });
    } else if (depth > 0) {
      body += character;
    } else if (character === ';') {
      statements.push(pending);
      pending = '';
    } else {
      pending += character;
    }
    if (opensBlock) depth++;
    if (closesBlock) depth--;
  }
  statements.push(pending);
  return { statements, rules };
}

function topLevelSelectorsOf(selectorList: string): string[] {
  const selectors: string[] = [];
  let current = '';
  let parenthesisDepth = 0;
  for (const character of selectorList) {
    if (character === '(') parenthesisDepth++;
    if (character === ')') parenthesisDepth--;
    const separatesSelectors = character === ',' && parenthesisDepth === 0;
    if (separatesSelectors) {
      selectors.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  return [...selectors, current];
}

function withoutNegations(selector: string): string {
  const withoutInnermostNegations = selector.replace(NEGATION_WITHOUT_NESTED_PARENTHESES, '');
  const hasNothingLeftToStrip = withoutInnermostNegations === selector;
  return hasNothingLeftToStrip ? selector : withoutNegations(withoutInnermostNegations);
}

function isFocusSelectorList(selectorList: string): boolean {
  return topLevelSelectorsOf(selectorList).some((selector) => FOCUS_PSEUDO_CLASS.test(withoutNegations(selector)));
}

function ringCandidatesIn({ statement, isInsideFocusRule }: { statement: string; isInsideFocusRule: boolean }): string[] {
  const ringDeclarations = statement.match(OUTLINE_SHADOW_AND_RING_PROPERTY_DECLARATION) ?? [];
  const borderDeclarations = isInsideFocusRule ? (statement.match(BORDER_DECLARATION) ?? []) : [];
  return [...ringDeclarations, ...borderDeclarations].map(collapseWhitespace);
}

function pixelRingsInBlock({
  css,
  selector,
  isInsideFocusRule,
}: {
  css: string;
  selector: string;
  isInsideFocusRule: boolean;
}): PixelRing[] {
  const { statements, rules } = splitIntoStatementsAndRules(css);
  const ownRings = statements
    .flatMap((statement) => ringCandidatesIn({ statement, isInsideFocusRule }))
    .filter((declaration) => PIXEL_VALUE_BEYOND_HAIRLINE.test(declaration))
    .map((declaration) => ({ selector, declaration }));
  const nestedRings = rules.flatMap((rule) =>
    pixelRingsInBlock({ css: rule.body, selector: rule.selector, isInsideFocusRule: isInsideFocusRule || isFocusSelectorList(rule.selector) }),
  );
  return [...ownRings, ...nestedRings];
}

function pixelRingsIn(source: string): PixelRing[] {
  return pixelRingsInBlock({ css: source.replace(CSS_COMMENT, ''), selector: '', isInsideFocusRule: false });
}

function pixelRingDeclarationsIn(source: string): string[] {
  return pixelRingsIn(source).map(({ declaration }) => declaration);
}

function inlineStylePixelRingsIn(markup: string): PixelRing[] {
  const attributeStyles = [...markup.matchAll(INLINE_STYLE_ATTRIBUTE)].map(([, , style]) => style ?? '');
  const bindingStyles = [...markup.matchAll(INLINE_STYLE_BINDING)].map(([, property, pixelUnit, , value]) => `${property}: ${value}${pixelUnit ? 'px' : ''}`);
  return [...attributeStyles, ...bindingStyles].flatMap((style) => pixelRingsIn(style));
}

interface StyleSource {
  path: string;
  source: string;
}

function stylesheetTextsIn({ path, source }: StyleSource): string[] {
  if (path.endsWith('.scss')) return [source];
  if (path.endsWith('.html')) return [...source.matchAll(STYLE_ELEMENT)].map(([, css]) => css ?? '');
  const stylesProperties = [...source.matchAll(STYLES_PROPERTY_LITERALS)].map(([, literals]) => literals ?? '');
  return stylesProperties.flatMap((literals) => [...literals.matchAll(TEMPLATE_LITERAL)].map(([, css]) => css ?? ''));
}

function pixelRingsInFile({ path, source }: StyleSource): PixelRing[] {
  const stylesheetRings = stylesheetTextsIn({ path, source }).flatMap((css) => pixelRingsIn(css));
  const inlineRings = path.endsWith('.scss') ? [] : inlineStylePixelRingsIn(source);
  return [...stylesheetRings, ...inlineRings];
}

interface ElevationShadowAllowance {
  path: string;
  selector: string;
  declaration: string;
  name: string;
}

const ELEVATION_SHADOW_ALLOWED: ElevationShadowAllowance[] = [];

function isNamed(allowance: ElevationShadowAllowance): boolean {
  return allowance.name.trim() !== '';
}

function invalidAllowances(allowlist: ElevationShadowAllowance[]): ElevationShadowAllowance[] {
  return allowlist.filter((allowance) => !isNamed(allowance));
}

function unallowedPixelRingsIn({
  path,
  source,
  allowlist = ELEVATION_SHADOW_ALLOWED,
}: StyleSource & { allowlist?: ElevationShadowAllowance[] }): PixelRing[] {
  const isAllowedElevation = ({ selector, declaration }: PixelRing) =>
    allowlist.filter(isNamed).some((allowance) => allowance.path === path && allowance.selector === selector && allowance.declaration === declaration);
  return pixelRingsInFile({ path, source }).filter((ring) => !isAllowedElevation(ring));
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

function templateSources(): StyleSource[] {
  return sourcesEndingWith('.component.html');
}

function globalStylesheetSources(): StyleSource[] {
  return sourcesEndingWith('.scss');
}

describe('the pixel ring detector', () => {
  it('flags a focus-visible outline sized in pixels', () => {
    const source = '.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline: 2px solid var(--accent)', 'outline-offset: -2px']);
  });

  it('flags a has-focus-visible box-shadow ring sized in pixels', () => {
    const source = '.mode:has(input:focus-visible) { box-shadow: 0 0 0 3px var(--accent) }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['box-shadow: 0 0 0 3px var(--accent)']);
  });

  it('flags a persistent selection bar sized in pixels', () => {
    const source = ".row[aria-current='true'] { box-shadow: inset 2px 0 0 var(--accent) }";

    expect(pixelRingDeclarationsIn(source)).toEqual(['box-shadow: inset 2px 0 0 var(--accent)']);
  });

  it('flags an outline-width sized in pixels', () => {
    const source = '.tab:focus-visible { outline-width: 2px }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline-width: 2px']);
  });

  it('flags a drop-shadow filter ring sized in pixels', () => {
    const source = '.tab:focus-visible { filter: drop-shadow(0 0 2px var(--accent)) }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['filter: drop-shadow(0 0 2px var(--accent))']);
  });

  it('flags an uppercase PX unit', () => {
    const source = '.tab:focus-visible { outline: 2PX solid var(--accent) }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline: 2PX solid var(--accent)']);
  });

  it.each([
    ['--ring', '.tab { --ring: 2px }', '--ring: 2px'],
    ['--focus-width', '.tab { --focus-width: 3px }', '--focus-width: 3px'],
    ['--tab-ring-size', '.tab { --tab-ring-size: 2px }', '--tab-ring-size: 2px'],
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

  it('accepts a rounded corner inside a focus rule', () => {
    const source = '.tab:focus-visible { border-radius: 12px; border-color: red }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });
});

describe('the logical border longhands inside a focus rule', () => {
  it.each([
    'border-inline-start-width',
    'border-inline-end-width',
    'border-block-start-width',
    'border-block-end-width',
    'border-inline-width',
    'border-block-width',
    'border-top-width',
    'border-left-width',
  ])('flags %s sized in pixels', (property) => {
    const source = `.tab:focus-visible { ${property}: 2px }`;

    expect(pixelRingDeclarationsIn(source)).toEqual([`${property}: 2px`]);
  });

  it.each(['border-inline', 'border-block', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-inline-start', 'border-block-end'])(
    'flags the %s shorthand sized in pixels',
    (property) => {
      const source = `.tab:focus-visible { ${property}: 2px solid red }`;

      expect(pixelRingDeclarationsIn(source)).toEqual([`${property}: 2px solid red`]);
    },
  );

  it('accepts a one pixel logical border', () => {
    const source = '.tab:focus-visible { border-inline-start-width: 1px; border-block: 1px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('accepts a logical border outside a focus rule', () => {
    const source = '.card { border-inline-start-width: 4px }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });
});

describe('the focus rule matching', () => {
  it('counts a border in a rule nested inside a focus rule', () => {
    const source = '.a:focus-visible { .b { border: 2px solid red } }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red']);
  });

  it('counts a border in a deeply nested rule inside a focus rule', () => {
    const source = '.a:focus-visible { .b { .c { border-width: 2px } } }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border-width: 2px']);
  });

  it('counts a border in an ampersand focus rule nested in a plain rule', () => {
    const source = '.a { &:focus-visible { border-width: 2px } }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border-width: 2px']);
  });

  it('counts a border declared after a nested rule of the same focus rule', () => {
    const source = '.a:focus-visible { .b { color: red } border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red']);
  });

  it('accepts a pixel border in a nested rule of a plain rule', () => {
    const source = '.a { .b { border: 2px solid red } }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('counts a focus rule inside an at-media block', () => {
    const source = '@media (hover: hover) { .tab:focus-visible { border: 2px solid red } }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red']);
  });

  it('accepts a plain rule inside an at-media block', () => {
    const source = '@media (hover: hover) { .tab { border: 2px solid red } }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('counts the body of a selector list with one focus selector', () => {
    const source = '.a, .b:focus-visible, .c { border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red']);
  });

  it('accepts the body of a selector list without a focus selector', () => {
    const source = '.a, .b, .c:hover { border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it.each([':not(:focus)', ':not(:focus-visible)', ':not(:focus-within)'])('accepts a pixel border under %s', (negation) => {
    const source = `.tab${negation} { border: 2px solid red }`;

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('counts a focus selector next to a negated one', () => {
    const source = '.tab:not(:hover):focus-visible { border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red']);
  });

  it('accepts a pixel border after a comment that mentions focus', () => {
    const source = '/* the :focus ring lives below */ .card { border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('accepts a pixel border after a line comment that mentions focus', () => {
    const source = '// the :focus-visible ring lives below\n.card { border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('counts a border next to a comment inside a focus rule', () => {
    const source = '.tab:focus-visible { /* ring: */ border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red']);
  });

  it('ignores a ring declaration written inside a comment', () => {
    const source = '.tab { /* outline: 2px solid red */ color: red }';

    expect(pixelRingDeclarationsIn(source)).toEqual([]);
  });

  it('joins a declaration split over several lines', () => {
    const source = '.tab:focus-visible {\n  border:\n    2px solid\n    red;\n  box-shadow:\n    0 0 0 3px\n    blue;\n}';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red', 'box-shadow: 0 0 0 3px blue']);
  });
});

describe('the inline style detector', () => {
  const inlineDeclarationsIn = (source: string) => inlineStylePixelRingsIn(source).map(({ declaration }) => declaration);

  it('flags an outline in a style attribute', () => {
    expect(inlineDeclarationsIn('<button style="outline: 2px solid red">')).toEqual(['outline: 2px solid red']);
  });

  it('flags a box-shadow in a single-quoted style attribute', () => {
    expect(inlineDeclarationsIn("<button style='color: red; box-shadow: 0 0 0 3px blue'>")).toEqual(['box-shadow: 0 0 0 3px blue']);
  });

  it('flags a style attribute split over lines', () => {
    expect(inlineDeclarationsIn('<button\n  style="outline:\n    2px solid red"\n>')).toEqual(['outline: 2px solid red']);
  });

  it.each([
    ['outline', `[style.outline]="'2px solid red'"`, `outline: '2px solid red'`],
    ['outline-offset', `[style.outline-offset]="'3px'"`, `outline-offset: '3px'`],
    ['box-shadow', `[style.box-shadow]="'0 0 0 2px ' + color"`, `box-shadow: '0 0 0 2px ' + color`],
    ['pixel unit outline-offset', `[style.outline-offset.px]="3"`, 'outline-offset: 3px'],
    ['ring custom property', `[style.--ring-size]="'2px'"`, `--ring-size: '2px'`],
  ])('flags a %s style binding sized in pixels', (_name, source, declaration) => {
    expect(inlineDeclarationsIn(`<button ${source}>`)).toEqual([declaration]);
  });

  it('accepts rem rings, hairlines and unrelated style bindings', () => {
    const source = `<i style="outline: .125rem solid red; box-shadow: inset 0 0 0 1px red" [style.outline]="'.125rem solid red'" [style.width]="'20px'" [style.outline-offset.px]="1"></i>`;

    expect(inlineDeclarationsIn(source)).toEqual([]);
  });
});

describe('the scanned file kinds', () => {
  it('reads the styles of a component typescript file', () => {
    const source = '@Component({ styles: [`.tab:focus-visible { outline: 2px solid red }`] }) export class TabComponent {}';

    expect(pixelRingsInFile({ path: 'ui/tab.component.ts', source })).toEqual([{ selector: '.tab:focus-visible', declaration: 'outline: 2px solid red' }]);
  });

  it('reads every stylesheet of a styles array', () => {
    const source = '@Component({ styles: [`.a { color: red }`, `.b:focus-visible { box-shadow: 0 0 0 2px red }`] }) export class AComponent {}';

    expect(pixelRingsInFile({ path: 'ui/a.component.ts', source })).toEqual([{ selector: '.b:focus-visible', declaration: 'box-shadow: 0 0 0 2px red' }]);
  });

  it('reads the inline style of a component template exactly once', () => {
    const source = '@Component({ template: `<i style="box-shadow: 0 0 0 3px red"></i>` }) export class IComponent {}';

    expect(pixelRingsInFile({ path: 'ui/i.component.ts', source })).toEqual([{ selector: '', declaration: 'box-shadow: 0 0 0 3px red' }]);
  });

  it('reads the style element and the style bindings of a component html file', () => {
    const source = '<style>.a:focus-visible { border: 2px solid red }</style><i [style.outline]="\'2px solid red\'"></i>';

    expect(pixelRingsInFile({ path: 'ui/a.component.html', source })).toEqual([
      { selector: '.a:focus-visible', declaration: 'border: 2px solid red' },
      { selector: '', declaration: `outline: '2px solid red'` },
    ]);
  });

  it('reads a scss file whole', () => {
    const source = '.tab:focus-visible { outline: 2px solid red }';

    expect(pixelRingsInFile({ path: 'styles.scss', source })).toEqual([{ selector: '.tab:focus-visible', declaration: 'outline: 2px solid red' }]);
  });

  it('ignores typescript outside the styles and the template', () => {
    const source = "const note = `outline: 2px solid red`; @Component({ styles: [``] }) export class NoteComponent {}";

    expect(pixelRingsInFile({ path: 'ui/note.component.ts', source })).toEqual([]);
  });
});

describe('the elevation shadow allowlist', () => {
  const cardElevation = { path: 'ui/card.scss', selector: '.card', declaration: 'box-shadow: 0 4px 12px rgba(0, 0, 0, .2)', name: 'card elevation' };
  const allowlist = [cardElevation];
  const cardShadowSource = '.card { box-shadow: 0 4px 12px rgba(0, 0, 0, .2) }';

  it('allows a named elevation shadow in its own file and rule', () => {
    expect(unallowedPixelRingsIn({ path: 'ui/card.scss', source: cardShadowSource, allowlist })).toEqual([]);
  });

  it('allows the shadow when the rule selector is spaced differently', () => {
    const source = '.card\n{ box-shadow: 0 4px 12px rgba(0, 0, 0, .2) }';

    expect(unallowedPixelRingsIn({ path: 'ui/card.scss', source, allowlist })).toEqual([]);
  });

  it('flags the same shadow in another file', () => {
    expect(unallowedPixelRingsIn({ path: 'ui/tab.scss', source: cardShadowSource, allowlist })).toEqual([
      { selector: '.card', declaration: 'box-shadow: 0 4px 12px rgba(0, 0, 0, .2)' },
    ]);
  });

  it('flags the same shadow in another rule of the allowed file', () => {
    const source = '.menu { box-shadow: 0 4px 12px rgba(0, 0, 0, .2) }';

    expect(unallowedPixelRingsIn({ path: 'ui/card.scss', source, allowlist })).toEqual([
      { selector: '.menu', declaration: 'box-shadow: 0 4px 12px rgba(0, 0, 0, .2)' },
    ]);
  });

  it('flags another shadow in the allowed file and rule', () => {
    const source = '.card { box-shadow: 0 0 0 3px var(--accent) }';

    expect(unallowedPixelRingsIn({ path: 'ui/card.scss', source, allowlist })).toEqual([
      { selector: '.card', declaration: 'box-shadow: 0 0 0 3px var(--accent)' },
    ]);
  });

  it('flags the shadow when its allowance has an empty name', () => {
    const nameless = [{ ...cardElevation, name: '' }];

    expect(unallowedPixelRingsIn({ path: 'ui/card.scss', source: cardShadowSource, allowlist: nameless })).toHaveLength(1);
  });

  it('reports an allowance whose name is empty or blank', () => {
    const entries = [cardElevation, { ...cardElevation, name: '' }, { ...cardElevation, name: '   ' }];

    expect(invalidAllowances(entries)).toEqual([entries[1], entries[2]]);
  });

  it('accepts allowances that all carry a name', () => {
    expect(invalidAllowances(allowlist)).toEqual([]);
  });

  it('is empty on the current sources', () => {
    expect(ELEVATION_SHADOW_ALLOWED).toEqual([]);
  });

  it('names every allowance on the current sources', () => {
    expect(invalidAllowances(ELEVATION_SHADOW_ALLOWED)).toEqual([]);
  });
});

describe('the desktop component sources', () => {
  const components = componentSources();
  const templates = templateSources();
  const globalStylesheets = globalStylesheetSources();

  it('lists the components it scans', () => {
    expect(components.length).toBeGreaterThan(50);
  });

  it('lists the global stylesheets it scans', () => {
    expect(globalStylesheets.length).toBeGreaterThanOrEqual(1);
    expect(globalStylesheets.map(({ path }) => path)).toContain('styles.scss');
  });

  it('size every outline, outline offset, box-shadow, drop-shadow and ring property in rem', () => {
    const pixelRings = [...components, ...templates, ...globalStylesheets].flatMap(({ path, source }) =>
      unallowedPixelRingsIn({ path, source }).map(({ selector, declaration }) => `${path}: ${selector} { ${declaration} }`),
    );

    expect(pixelRings).toEqual([]);
  });

  it('ship their styles inline, where the scan and the unit spec can read them', () => {
    const componentsWithExternalStylesheet = components.filter(({ source }) => EXTERNAL_STYLESHEET.test(source)).map(({ path }) => path);

    expect(componentsWithExternalStylesheet).toEqual([]);
  });
});
