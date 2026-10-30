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
// A pixel width computed at runtime, such as [style.box-shadow]="'0 0 0 ' + width + 'px'", is not decidable by this source scan.
const BORDER_PROPERTY_NAME = String.raw`border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-width)?`;
const BORDER_DECLARATION = new RegExp(String.raw`(?<![\w-])${BORDER_PROPERTY_NAME}\s*:[^;}]*`, 'gi');
const BORDER_DECLARATION_TEXT = new RegExp(String.raw`^${BORDER_PROPERTY_NAME}\s*:`, 'i');
const KEYWORD_BORDER_WIDTH = /(?<![\w-])(?:medium|thick)(?![\w-])/i;
const PIXEL_VALUE_BEYOND_HAIRLINE = /(?<![\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px/i;
const EXTERNAL_STYLESHEET = /\bstyleUrls?["'`]?\s*:/;
const FOCUS_PSEUDO_CLASS = /:focus\b/i;
const NEGATION_WITHOUT_NESTED_PARENTHESES = /:not\([^()]*\)/g;
const INLINE_STYLE_ATTRIBUTE = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/g;
const HOST_PROPERTY_OPENING = /\bhost\s*:\s*\{/g;
const HOST_STYLE_ENTRY = /["']?\bstyle["']?\s*:\s*(["'`])([\s\S]*?)\1/g;
const INLINE_STYLE_BINDING = new RegExp(
  String.raw`(?:\[style\.|\bbind-style\.)(${RING_PROPERTY_NAME}|filter)(\.px)?\]?["']?\s*[=:]\s*(["'\`])([\s\S]*?)\3`,
  'gi',
);
const STYLE_MAP_BINDING = /(?:\[(?:style|ngStyle)\]|\bbind-(?:style|ngStyle))["']?\s*[=:]\s*(["'`])([\s\S]*?)\1/gi;
const ADJACENT_STRING_LITERALS_JOINED_BY_PLUS = /["'`]\s*\+\s*["'`]/g;
const STYLES_PROPERTY_KEY = /\bstyles["'`]?\s*:/g;
const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_CONSTANT_FILE = /(?:^|\/)[^/]*styles[^/]*\.ts$/;
const OPAQUE_INTERPOLATION = '/* interpolation */';

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

function blanked(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

function maskedWith(mask: string, text: string): string {
  return text.replace(/[^\n]/g, mask);
}

function endOfCssString({ css, start }: { css: string; start: number }): number {
  const quote = css[start];
  let cursor = start + 1;
  while (cursor < css.length && css[cursor] !== quote && css[cursor] !== '\n') cursor += css[cursor] === '\\' ? 2 : 1;
  return Math.min(css[cursor] === quote ? cursor + 1 : cursor, css.length);
}

/** Returns the css with comments blanked (`code`) and, in addition, string and url() contents masked (`structure`), both keeping every offset. */
function lexCss({ css, isScss }: { css: string; isScss: boolean }): { code: string; structure: string } {
  let code = '';
  let structure = '';
  let cursor = 0;
  while (cursor < css.length) {
    const character = css[cursor] as string;
    const next = css[cursor + 1];
    const opensBlockComment = character === '/' && next === '*';
    const opensLineComment = isScss && character === '/' && next === '/';
    const opensString = character === '"' || character === "'";
    const opensUnquotedUrl = /^url\(\s*(?!["'\s])/i.test(css.slice(cursor, cursor + 8)) && !/[\w-]/.test(css[cursor - 1] ?? '');
    if (opensBlockComment || opensLineComment) {
      const commentEnd = opensBlockComment ? css.indexOf('*/', cursor + 2) : css.indexOf('\n', cursor);
      const end = commentEnd === -1 ? css.length : commentEnd + (opensBlockComment ? 2 : 0);
      code += blanked(css.slice(cursor, end));
      structure += blanked(css.slice(cursor, end));
      cursor = end;
    } else if (opensString) {
      const end = endOfCssString({ css, start: cursor });
      code += css.slice(cursor, end);
      structure += maskedWith('_', css.slice(cursor, end));
      cursor = end;
    } else if (opensUnquotedUrl) {
      const closing = css.indexOf(')', cursor);
      const end = closing === -1 ? css.length : closing;
      code += css.slice(cursor, end);
      structure += maskedWith('_', css.slice(cursor, end));
      cursor = end;
    } else {
      code += character;
      structure += character;
      cursor++;
    }
  }
  return { code, structure };
}

function splitIntoStatementsAndRules(css: string): { statements: string[]; rules: CssRule[] } {
  const statements: string[] = [];
  const rules: CssRule[] = [];
  const { structure } = lexCss({ css, isScss: false });
  let pending = '';
  let selector = '';
  let body = '';
  let depth = 0;
  for (let offset = 0; offset < css.length; offset++) {
    const character = css[offset] as string;
    const controlCharacter = structure[offset];
    const isStrayClosingBrace = controlCharacter === '}' && depth === 0;
    if (isStrayClosingBrace) throw new Error(`stray '}' at offset ${offset}`);
    const opensBlock = controlCharacter === '{';
    const closesBlock = controlCharacter === '}';
    if (opensBlock && depth === 0) {
      selector = pending;
      pending = '';
      body = '';
    } else if (closesBlock && depth === 1) {
      rules.push({ selector: collapseWhitespace(selector), body });
    } else if (depth > 0) {
      body += character;
    } else if (controlCharacter === ';') {
      statements.push(pending);
      pending = '';
    } else {
      pending += character;
    }
    if (opensBlock) depth++;
    if (closesBlock) depth--;
  }
  if (depth > 0) throw new Error(`${depth} unclosed '{' at offset ${css.length}`);
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

function isWiderThanHairline(declaration: string): boolean {
  const hasPixelWidthBeyondHairline = PIXEL_VALUE_BEYOND_HAIRLINE.test(declaration);
  const isBorderWithKeywordWidth = BORDER_DECLARATION_TEXT.test(declaration) && KEYWORD_BORDER_WIDTH.test(declaration);
  return hasPixelWidthBeyondHairline || isBorderWithKeywordWidth;
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
    .filter(isWiderThanHairline)
    .map((declaration) => ({ selector, declaration }));
  const nestedRings = rules.flatMap((rule) =>
    pixelRingsInBlock({ css: rule.body, selector: rule.selector, isInsideFocusRule: isInsideFocusRule || isFocusSelectorList(rule.selector) }),
  );
  return [...ownRings, ...nestedRings];
}

function pixelRingsIn(source: string, { isScss = false }: { isScss?: boolean } = {}): PixelRing[] {
  const { code } = lexCss({ css: source, isScss });
  return pixelRingsInBlock({ css: code, selector: '', isInsideFocusRule: false });
}

function pixelRingDeclarationsIn(source: string): string[] {
  return pixelRingsIn(source).map(({ declaration }) => declaration);
}

function joinedLiterals(expression: string): string {
  return expression.replace(ADJACENT_STRING_LITERALS_JOINED_BY_PLUS, '');
}

function declarationsOfStyleMap(styleMap: string): string {
  return joinedLiterals(styleMap)
    .replace(/["'`{}]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\.px\s*:\s*([\d.]+)/g, ': $1px')
    .replace(/,\s*(?=[\w-]+\s*:)/g, '; ');
}

function isQuote(character: string | undefined): boolean {
  return character === '"' || character === "'" || character === '`';
}

function endOfInterpolation({ source, start }: { source: string; start: number }): number {
  let depth = 1;
  let cursor = start;
  while (cursor < source.length && depth > 0) {
    const character = source[cursor];
    if (isQuote(character)) {
      cursor = scanQuoted({ source, start: cursor }).end;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') depth--;
    cursor++;
  }
  return cursor;
}

function scanQuoted({ source, start }: { source: string; start: number }): { value: string; end: number } {
  const quote = source[start] as string;
  const isTemplate = quote === '`';
  let value = '';
  let cursor = start + 1;
  while (cursor < source.length && source[cursor] !== quote) {
    if (isTemplate && source.startsWith('${', cursor)) {
      value += OPAQUE_INTERPOLATION;
      cursor = endOfInterpolation({ source, start: cursor + 2 });
      continue;
    }
    const characterCount = source[cursor] === '\\' ? 2 : 1;
    value += source.slice(cursor, cursor + characterCount);
    cursor += characterCount;
  }
  return { value, end: Math.min(cursor + 1, source.length) };
}

function skipTrivia({ source, start }: { source: string; start: number }): number {
  let cursor = start;
  while (cursor < source.length) {
    const isWhitespace = /\s/.test(source[cursor] as string);
    const opensLineComment = source.startsWith('//', cursor);
    const opensBlockComment = source.startsWith('/*', cursor);
    if (isWhitespace) {
      cursor++;
    } else if (opensLineComment) {
      const lineEnd = source.indexOf('\n', cursor);
      cursor = lineEnd === -1 ? source.length : lineEnd;
    } else if (opensBlockComment) {
      const commentEnd = source.indexOf('*/', cursor + 2);
      cursor = commentEnd === -1 ? source.length : commentEnd + 2;
    } else {
      return cursor;
    }
  }
  return cursor;
}

function withOpaqueInterpolations(text: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    if (text.startsWith('${', cursor)) {
      result += OPAQUE_INTERPOLATION;
      cursor = endOfInterpolation({ source: text, start: cursor + 2 });
    } else {
      result += text[cursor];
      cursor++;
    }
  }
  return result;
}

/** Returns the offset just after the colon of every `styles:` key that sits in code, outside strings and comments. */
function stylesPropertyValueStartsIn(source: string): number[] {
  const starts: number[] = [];
  const colonAfterKey = /\s*:/y;
  const word = /[\w$]+/y;
  const recordKeyEndingAt = (keyEnd: number) => {
    colonAfterKey.lastIndex = keyEnd;
    const colon = colonAfterKey.exec(source);
    if (colon) starts.push(keyEnd + colon[0].length);
  };
  let cursor = skipTrivia({ source, start: 0 });
  while (cursor < source.length) {
    if (isQuote(source[cursor])) {
      const { value, end } = scanQuoted({ source, start: cursor });
      if (value === 'styles') recordKeyEndingAt(end);
      cursor = end;
    } else {
      word.lastIndex = cursor;
      const identifier = word.exec(source)?.[0];
      const isStylesKey = identifier === 'styles' && source[cursor - 1] !== '.';
      if (isStylesKey) recordKeyEndingAt(cursor + identifier.length);
      cursor += identifier?.length ?? 1;
    }
    cursor = skipTrivia({ source, start: cursor });
  }
  return starts;
}

function stringLiteralsIn(source: string): string[] {
  const literals: string[] = [];
  let cursor = skipTrivia({ source, start: 0 });
  while (cursor < source.length) {
    if (isQuote(source[cursor])) {
      const { value, end } = scanQuoted({ source, start: cursor });
      literals.push(value);
      cursor = end;
    } else {
      cursor++;
    }
    cursor = skipTrivia({ source, start: cursor });
  }
  return literals;
}

interface StylesExpression {
  text: string;
  references: string[];
  end: number;
}

function readStylesOperand({ source, start }: { source: string; start: number }): { text: string; reference?: string; end: number } {
  const cursor = skipTrivia({ source, start });
  if (isQuote(source[cursor])) {
    const { value, end } = scanQuoted({ source, start: cursor });
    return { text: value, end };
  }
  const identifier = /[A-Za-z_$][\w$]*/y;
  identifier.lastIndex = cursor;
  const reference = identifier.exec(source)?.[0];
  if (reference === undefined) throw new Error(`unsupported styles value at offset ${cursor}`);
  return { text: OPAQUE_INTERPOLATION, reference, end: cursor + reference.length };
}

function readStylesExpression({ source, start }: { source: string; start: number }): StylesExpression {
  let text = '';
  const references: string[] = [];
  let cursor = start;
  for (;;) {
    const operand = readStylesOperand({ source, start: cursor });
    text += operand.text;
    if (operand.reference !== undefined) references.push(operand.reference);
    const afterOperand = skipTrivia({ source, start: operand.end });
    if (source[afterOperand] !== '+') return { text, references, end: afterOperand };
    cursor = afterOperand + 1;
  }
}

function readStylesValue({ source, start }: { source: string; start: number }): StylesExpression[] {
  const valueStart = skipTrivia({ source, start });
  const isArray = source[valueStart] === '[';
  if (!isArray) {
    const expression = readStylesExpression({ source, start: valueStart });
    const terminator = source[expression.end];
    const endsTheValue = terminator === undefined || terminator === ',' || terminator === '}';
    if (!endsTheValue) throw new Error(`unsupported styles value at offset ${expression.end}`);
    return [expression];
  }
  const expressions: StylesExpression[] = [];
  let cursor = skipTrivia({ source, start: valueStart + 1 });
  while (source[cursor] !== ']') {
    const expression = readStylesExpression({ source, start: cursor });
    expressions.push(expression);
    const terminator = source[expression.end];
    const continuesTheArray = terminator === ',';
    if (!continuesTheArray && terminator !== ']') throw new Error(`unsupported styles value at offset ${expression.end}`);
    cursor = skipTrivia({ source, start: continuesTheArray ? expression.end + 1 : expression.end });
  }
  return expressions;
}

function escapedForRegExp(text: string): string {
  return text.replace(/[$\\^.*+?()[\]{}|]/g, '\\$&');
}

function stylesheetsOfReference({ source, reference, resolving }: { source: string; reference: string; resolving: Set<string> }): string[] {
  const name = escapedForRegExp(reference);
  const importedFromStylesModule = new RegExp(
    String.raw`import\s*(?:type\s*)?\{[^}]*(?<![\w$])${name}(?![\w$])[^}]*\}\s*from\s*["'](?:[^"'/]*/)*[^"'/]*styles[^"'/]*["']`,
  ).test(source);
  if (importedFromStylesModule) return [];
  const declaration = new RegExp(String.raw`(?<![\w$])const\s+${name}(?![\w$])[^=;]*=`).exec(source);
  const isResolvable = declaration !== null && !resolving.has(reference);
  if (!isResolvable) throw new Error(`styles reference "${reference}" is neither imported from a styles module nor a constant of the file`);
  const expression = readStylesExpression({ source, start: declaration.index + declaration[0].length });
  return stylesheetsOfExpression({ source, expression, resolving: new Set([...resolving, reference]) });
}

function stylesheetsOfExpression({ source, expression, resolving }: { source: string; expression: StylesExpression; resolving: Set<string> }): string[] {
  const referencedStylesheets = expression.references.flatMap((reference) => stylesheetsOfReference({ source, reference, resolving }));
  return [expression.text, ...referencedStylesheets];
}

function stylesPropertyStylesheetsIn(source: string): string[] {
  const declaredStylesProperties = [...source.matchAll(STYLES_PROPERTY_KEY)].length;
  const extractedStylesArrays = stylesPropertyValueStartsIn(source).map((start) => readStylesValue({ source, start }));
  if (extractedStylesArrays.length !== declaredStylesProperties) {
    throw new Error(`${extractedStylesArrays.length} styles array(s) extracted for ${declaredStylesProperties} styles properties`);
  }
  return extractedStylesArrays
    .flat()
    .flatMap((expression) => stylesheetsOfExpression({ source, expression, resolving: new Set() }));
}

function hostObjectTextsIn(source: string): string[] {
  return [...source.matchAll(HOST_PROPERTY_OPENING)].map((opening) => {
    const start = (opening.index ?? 0) + opening[0].length;
    return source.slice(start, endOfInterpolation({ source, start }));
  });
}

function inlineStylePixelRingsIn(markup: string): PixelRing[] {
  const attributeStyles = [...markup.matchAll(INLINE_STYLE_ATTRIBUTE)].map(([, , style]) => style ?? '');
  const hostStyles = hostObjectTextsIn(markup).flatMap((host) => [...host.matchAll(HOST_STYLE_ENTRY)].map(([, , style]) => style ?? ''));
  const propertyBindingStyles = [...markup.matchAll(INLINE_STYLE_BINDING)].map(
    ([, property, pixelUnit, , value]) => `${property}: ${joinedLiterals(value ?? '')}${pixelUnit ? 'px' : ''}`,
  );
  const styleMapStyles = [...markup.matchAll(STYLE_MAP_BINDING)].map(([, , styleMap]) => declarationsOfStyleMap(styleMap ?? ''));
  return [...attributeStyles, ...hostStyles, ...propertyBindingStyles, ...styleMapStyles].flatMap((style) => pixelRingsIn(style));
}

interface StyleSource {
  path: string;
  source: string;
}

function styleElementsIn(source: string): string[] {
  return [...source.matchAll(STYLE_ELEMENT)].map(([, css]) => withOpaqueInterpolations(css ?? ''));
}

function isStyleConstantFile(path: string): boolean {
  return STYLE_CONSTANT_FILE.test(path) && !path.endsWith('.component.ts') && !path.endsWith('.spec.ts');
}

function stylesheetTextsIn({ path, source }: StyleSource): string[] {
  if (path.endsWith('.scss')) return [source];
  if (path.endsWith('.html')) return styleElementsIn(source);
  if (isStyleConstantFile(path)) return stringLiteralsIn(source);
  return [...stylesPropertyStylesheetsIn(source), ...styleElementsIn(source)];
}

function pixelRingsInFile({ path, source }: StyleSource): PixelRing[] {
  const isScss = path.endsWith('.scss');
  try {
    const stylesheetRings = stylesheetTextsIn({ path, source }).flatMap((css) => pixelRingsIn(css, { isScss }));
    const inlineRings = isScss ? [] : inlineStylePixelRingsIn(source);
    return [...stylesheetRings, ...inlineRings];
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function styleConstantSources(): StyleSource[] {
  return sourcesEndingWith('.ts').filter(({ path }) => isStyleConstantFile(path));
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

  it('accepts a pixel border after a scss line comment that mentions focus', () => {
    const source = '// the :focus-visible ring lives below\n.card { border: 2px solid red }';

    expect(pixelRingsInFile({ path: 'styles.scss', source })).toEqual([]);
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

describe('the styles property extraction', () => {
  const componentPath = 'ui/x.component.ts';
  const focusRing = '.a:focus-visible { outline: 2px solid red }';
  const focusRingFinding = [{ selector: '.a:focus-visible', declaration: 'outline: 2px solid red' }];
  const stylesImport = "import { STEP_PANEL_STYLES } from './step-panel.styles';";
  const ringsOfComponent = (source: string) => pixelRingsInFile({ path: componentPath, source });

  it('reads the template after an imported constant in a styles array', () => {
    const source = `${stylesImport} @Component({ styles: [\n  STEP_PANEL_STYLES,\n  \`${focusRing}\`,\n] })`;

    expect(ringsOfComponent(source)).toEqual(focusRingFinding);
  });

  it.each([
    ['single-quoted', `'${focusRing}'`],
    ['double-quoted', `"${focusRing}"`],
  ])('reads a %s literal of a styles array', (_name, literal) => {
    expect(ringsOfComponent(`@Component({ styles: [ ${literal} ] })`)).toEqual(focusRingFinding);
  });

  it('joins a concatenation of literals into one stylesheet', () => {
    const source = "@Component({ styles: ['.a:focus-visible { ' + 'outline: 2px solid red }'] })";

    expect(ringsOfComponent(source)).toEqual(focusRingFinding);
  });

  it('reads past comments between the items of a styles array', () => {
    const source = `@Component({ styles: [ // first\n /* second */ \`.b { color: red }\`, // third\n \`${focusRing}\` /* last */ ] })`;

    expect(ringsOfComponent(source)).toEqual(focusRingFinding);
  });

  it('keeps an interpolation opaque without breaking the declarations around it', () => {
    const source = '@Component({ styles: [`.a:focus-visible { outline: ${width}px solid red; box-shadow: 0 0 0 3px red }`] })';

    expect(ringsOfComponent(source)).toEqual([{ selector: '.a:focus-visible', declaration: 'box-shadow: 0 0 0 3px red' }]);
  });

  it('reads a quoted styles key', () => {
    expect(ringsOfComponent(`@Component({ 'styles': [\`${focusRing}\`] })`)).toEqual(focusRingFinding);
  });

  it('reads the template of a styles value that is a constant of the same file', () => {
    const source = `const PANEL = \`${focusRing}\`; @Component({ styles: PANEL })`;

    expect(ringsOfComponent(source)).toEqual(focusRingFinding);
  });

  it('accepts a styles value that is a constant imported from a styles module', () => {
    const source = `${stylesImport} @Component({ styles: STEP_PANEL_STYLES })`;

    expect(ringsOfComponent(source)).toEqual([]);
  });

  it.each([
    ['a function call', '@Component({ styles: buildStyles() })'],
    ['a spread', '@Component({ styles: [...SHARED, `.a { color: red }`] })'],
    ['a constant that is nowhere defined', '@Component({ styles: MISSING_STYLES })'],
    ['a constant imported from a module that is not a styles module', "import { OTHER } from './other'; @Component({ styles: OTHER })"],
    ['a type annotation', 'interface Compiled { styles: string[] }'],
  ])('fails closed on %s and names the file', (_name, source) => {
    expect(() => ringsOfComponent(source)).toThrow(componentPath);
  });

  it('fails closed when a styles key outside the code differs from the extracted arrays', () => {
    const source = '/* styles: [] */ @Component({ styles: [`.a { color: red }`] })';

    expect(() => ringsOfComponent(source)).toThrow(/1 styles array.*2 styles propert/);
  });
});

describe('the styles constant files', () => {
  const ringsOfStylesFile = (source: string) => pixelRingsInFile({ path: 'app/onboarding/step-panel.styles.ts', source });

  it.each([
    ['template', '`.a:focus-visible { outline: 2px solid red }`'],
    ['single-quoted', "'.a:focus-visible { outline: 2px solid red }'"],
    ['double-quoted', '".a:focus-visible { outline: 2px solid red }"'],
  ])('reads every %s literal as css', (_name, literal) => {
    const source = `export const STEP_PANEL_STYLES = ${literal};`;

    expect(ringsOfStylesFile(source)).toEqual([{ selector: '.a:focus-visible', declaration: 'outline: 2px solid red' }]);
  });

  it('reads a styles constant file named with a dash', () => {
    const source = 'export const SETTINGS_VALUE_STYLES = `.a:focus-visible { outline: 2px solid red }`;';

    expect(pixelRingsInFile({ path: 'app/settings/settings-value-styles.ts', source })).toHaveLength(1);
  });

  it('ignores the template literals of a typescript file that is not a styles file', () => {
    const source = 'export const NOTE = `.a:focus-visible { outline: 2px solid red }`;';

    expect(pixelRingsInFile({ path: 'app/util/note.ts', source })).toEqual([]);
  });
});

describe('the host, style map and template style sources', () => {
  const inlineDeclarationsIn = (source: string) => inlineStylePixelRingsIn(source).map(({ declaration }) => declaration);

  it.each([
    ['a host style entry', "host: { style: 'outline: 2px solid red' }", 'outline: 2px solid red'],
    ['a quoted host style key', `host: { 'style': "box-shadow: 0 0 0 3px red" }`, 'box-shadow: 0 0 0 3px red'],
    ['a host style binding key', `host: { '[style.outline]': "'2px solid red'" }`, `outline: '2px solid red'`],
    ['a host pixel unit binding key', `host: { '[style.outline-offset.px]': '3' }`, 'outline-offset: 3px'],
    ['a host binding with a space before the colon', `host: { '[style.box-shadow]' : "'0 0 0 3px red'" }`, `box-shadow: '0 0 0 3px red'`],
    ['an ngStyle map', `<i [ngStyle]="{'box-shadow': '0 0 0 3px red'}"></i>`, 'box-shadow: 0 0 0 3px red'],
    ['an ngStyle map with several keys', `<i [ngStyle]="{ color: 'blue', outline: '2px solid red' }"></i>`, 'outline: 2px solid red'],
    ['an ngStyle camel case key', `<i [ngStyle]="{ boxShadow: '0 0 0 3px red' }"></i>`, 'box-shadow: 0 0 0 3px red'],
    ['a style string binding', `<i [style]="'outline: 2px solid red'"></i>`, 'outline: 2px solid red'],
    ['a bind-style binding', `<i bind-style.outline="'2px solid red'"></i>`, `outline: '2px solid red'`],
    ['literals joined by a plus', `<i [style.box-shadow]="'0 0 0 ' + '3' + 'px red'"></i>`, `box-shadow: '0 0 0 3px red'`],
  ])('flags %s sized in pixels', (_name, source, declaration) => {
    expect(inlineDeclarationsIn(source)).toEqual([declaration]);
  });

  it('accepts host, style map and string bindings sized in rem or in hairlines', () => {
    const source = `host: { style: 'outline: .125rem solid red', '[style.outline-offset.px]': '1' } <i [ngStyle]="{ outline: '.125rem solid red', width: '20px' }" [style]="'box-shadow: inset 0 0 0 1px red'"></i>`;

    expect(inlineDeclarationsIn(source)).toEqual([]);
  });

  it('leaves a pixel width computed at runtime undecided', () => {
    expect(inlineDeclarationsIn(`<i [style.box-shadow]="'0 0 0 ' + width + 'px'"></i>`)).toEqual([]);
  });

  it('reads the style element of an inline component template', () => {
    const source = '@Component({ template: `<style>.a:focus-visible { border: 2px solid red }</style><i></i>` })';

    expect(pixelRingsInFile({ path: 'ui/x.component.ts', source })).toEqual([{ selector: '.a:focus-visible', declaration: 'border: 2px solid red' }]);
  });

  it('flags a host style entry once in a component file', () => {
    const source = "@Component({ host: { style: 'outline: 2px solid red' } })";

    expect(pixelRingsInFile({ path: 'ui/x.component.ts', source })).toEqual([{ selector: '', declaration: 'outline: 2px solid red' }]);
  });

  it.each(["styleUrl: './a.css'", "styleUrls: ['./a.css']", "'styleUrl': './a.css'", '"styleUrls": []', "styleUrl : './a.css'"])(
    'recognises the external stylesheet key in %s',
    (source) => {
      expect(EXTERNAL_STYLESHEET.test(source)).toBe(true);
    },
  );

  it('does not mistake a longer word for the external stylesheet key', () => {
    expect(EXTERNAL_STYLESHEET.test("const restyleUrl: string = ''")).toBe(false);
  });
});

describe('the stylesheet walker', () => {
  it('fails on a block that is never closed', () => {
    expect(() => pixelRingDeclarationsIn('.a { color: red')).toThrow(/unclosed.*offset 15/);
  });

  it('fails on a closing brace without an opening one', () => {
    expect(() => pixelRingDeclarationsIn('.a { color: red } }')).toThrow(/stray.*offset 18/);
  });

  it('names the file of a broken stylesheet', () => {
    expect(() => pixelRingsInFile({ path: 'ui/broken.scss', source: '.a { ' })).toThrow('ui/broken.scss');
  });

  it('does not take a double slash inside a url for a comment', () => {
    const source = '.tab:focus-visible { background: url(//cdn.test/a.png); outline: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline: 2px solid red']);
  });

  it('does not take a double slash inside a string for a comment', () => {
    const source = '.tab:focus-visible { content: "// not a comment"; outline: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline: 2px solid red']);
  });

  it('does not let a comment opener inside a string hide the code after it', () => {
    const source = '.tab:focus-visible { content: "/*"; outline: 2px solid red } .b { content: "*/" }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['outline: 2px solid red']);
  });

  it('does not let a closing brace inside a string end the rule', () => {
    const source = '.tab:focus-visible { content: "}"; border: 2px solid red }';

    expect(pixelRingDeclarationsIn(source)).toEqual(['border: 2px solid red']);
  });

  it('treats a double slash in component css as plain text', () => {
    const source = '@Component({ styles: [`.a { background: url(//cdn.test/a.png) } .tab:focus-visible { outline: 2px solid red }`] })';

    expect(pixelRingsInFile({ path: 'ui/x.component.ts', source })).toEqual([{ selector: '.tab:focus-visible', declaration: 'outline: 2px solid red' }]);
  });
});

describe('the focus rule border widths', () => {
  it('matches the border property and the focus pseudo-class in any letter case', () => {
    expect(pixelRingDeclarationsIn('.tab:FOCUS-VISIBLE { BORDER-WIDTH: 2px }')).toEqual(['BORDER-WIDTH: 2px']);
  });

  it.each(['medium', 'thick'])('flags the %s keyword border width inside a focus rule', (keyword) => {
    expect(pixelRingDeclarationsIn(`.tab:focus-visible { border: ${keyword} solid red }`)).toEqual([`border: ${keyword} solid red`]);
    expect(pixelRingDeclarationsIn(`.tab:focus-visible { border-inline-width: ${keyword} }`)).toEqual([`border-inline-width: ${keyword}`]);
  });

  it('accepts the thin keyword border width inside a focus rule', () => {
    expect(pixelRingDeclarationsIn('.tab:focus-visible { border: thin solid red }')).toEqual([]);
  });

  it('accepts a keyword border width outside a focus rule', () => {
    expect(pixelRingDeclarationsIn('.card { border: thick solid red }')).toEqual([]);
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
  const styleConstants = styleConstantSources();

  it('lists the components it scans', () => {
    expect(components.length).toBeGreaterThan(50);
  });

  it('lists the style constant files it scans', () => {
    expect(styleConstants.map(({ path }) => path).sort()).toEqual(['app/onboarding/step-panel.styles.ts', 'app/settings/settings-value-styles.ts']);
  });

  it.each(['daemon-step', 'project-step', 'first-session-step'])('reads the inline css of the %s onboarding component', (name) => {
    const path = `app/onboarding/${name}.component.ts`;
    const component = components.find((candidate) => candidate.path === path);

    expect(stylesheetTextsIn(component as StyleSource).join('\n')).toContain(':host');
  });

  it('reads the focus rules of the daemon step styles array', () => {
    const component = components.find(({ path }) => path === 'app/onboarding/daemon-step.component.ts');

    const stylesheets = stylesheetTextsIn(component as StyleSource).join('\n');

    expect(stylesheets).toContain('h2:focus-visible');
    expect(stylesheets).toContain('.last-line:focus-visible');
  });

  it('lists the global stylesheets it scans', () => {
    expect(globalStylesheets.length).toBeGreaterThanOrEqual(1);
    expect(globalStylesheets.map(({ path }) => path)).toContain('styles.scss');
  });

  it('size every outline, outline offset, box-shadow, drop-shadow and ring property in rem', () => {
    const pixelRings = [...components, ...templates, ...globalStylesheets, ...styleConstants].flatMap(({ path, source }) =>
      unallowedPixelRingsIn({ path, source }).map(({ selector, declaration }) => `${path}: ${selector} { ${declaration} }`),
    );

    expect(pixelRings).toEqual([]);
  });

  it('ship their styles inline, where the scan and the unit spec can read them', () => {
    const componentsWithExternalStylesheet = components.filter(({ source }) => EXTERNAL_STYLESHEET.test(source)).map(({ path }) => path);

    expect(componentsWithExternalStylesheet).toEqual([]);
  });
});
