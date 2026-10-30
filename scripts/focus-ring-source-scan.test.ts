import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
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
const HOST_STYLE_ENTRY = /(?<![\w$.-])(["']?)(?:style|\[attr\.style\])\1\s*:\s*(["'`])([\s\S]*?)\2/g;
const OUTER_QUOTES = /^\s*["'`]|["'`]\s*$/g;
const INLINE_STYLE_BINDING = new RegExp(
  String.raw`(?:\[style\.|\bbind-style\.)(${RING_PROPERTY_NAME}|filter)(\.px)?\]?["']?\s*[=:]\s*(["'\`])([\s\S]*?)\3`,
  'gi',
);
const STYLE_MAP_BINDING = /(?:\[(?:style|ngStyle)\]|\bbind-(?:style|ngStyle))["']?\s*[=:]\s*(["'`])([\s\S]*?)\1/gi;
const ADJACENT_STRING_LITERALS_JOINED_BY_PLUS = /["'`]\s*\+\s*["'`]/g;
const STYLES_PROPERTY_KEY = /(?<![\w$.])(?:styles|(["'`])styles\1\s*\]?)\s*:/g;
const STYLES_IDENTIFIER = /(?<![\w$.])styles(?![\w$])/g;
const RELATIVE_MODULE_SPECIFIER = /^\.\.?(?:\/|$)/;
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

/** Returns the source with comments blanked and, when asked, string contents masked, keeping every offset. */
function sourceWithoutComments({ source, maskStringContents }: { source: string; maskStringContents: boolean }): string {
  let result = '';
  let cursor = 0;
  while (cursor < source.length) {
    const opensComment = source.startsWith('//', cursor) || source.startsWith('/*', cursor);
    if (opensComment) {
      const end = skipTrivia({ source, start: cursor });
      result += blanked(source.slice(cursor, end));
      cursor = end;
    } else if (isQuote(source[cursor])) {
      const { end } = scanQuoted({ source, start: cursor });
      const literal = source.slice(cursor, end);
      result += maskStringContents ? literal.slice(0, 1) + maskedWith('_', literal.slice(1, -1)) + literal.slice(-1) : literal;
      cursor = end;
    } else {
      result += source[cursor];
      cursor++;
    }
  }
  return result;
}

/** Returns the offset just after the colon of every `styles:` key that sits in code, outside strings and comments. */
function stylesPropertyValueStartsIn(source: string): number[] {
  const starts: number[] = [];
  const word = /[\w$]+/y;
  const recordKeyEndingAt = ({ keyEnd, isQuotedKey }: { keyEnd: number; isQuotedKey: boolean }) => {
    const afterKey = skipTrivia({ source, start: keyEnd });
    const closesComputedKey = isQuotedKey && source[afterKey] === ']';
    const beforeColon = closesComputedKey ? skipTrivia({ source, start: afterKey + 1 }) : afterKey;
    if (source[beforeColon] === ':') starts.push(beforeColon + 1);
  };
  let cursor = skipTrivia({ source, start: 0 });
  while (cursor < source.length) {
    if (isQuote(source[cursor])) {
      const { value, end } = scanQuoted({ source, start: cursor });
      if (value === 'styles') recordKeyEndingAt({ keyEnd: end, isQuotedKey: true });
      cursor = end;
    } else {
      word.lastIndex = cursor;
      const identifier = word.exec(source)?.[0];
      const isStylesKey = identifier === 'styles' && source[cursor - 1] !== '.';
      if (isStylesKey) recordKeyEndingAt({ keyEnd: cursor + identifier.length, isQuotedKey: false });
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

interface ImportOrigin {
  path: string;
  scannedStylesModules: string[];
}

/** Returns the path of the scanned styles file an import specifier resolves to, or throws when that file is not scanned. */
function scannedStylesModuleOf({ specifier, reference, origin }: { specifier: string; reference: string; origin: ImportOrigin }): string {
  const isPackageImport = !RELATIVE_MODULE_SPECIFIER.test(specifier);
  if (isPackageImport) throw new Error(`styles reference "${reference}" is imported from the package "${specifier}", which is not scanned`);
  const resolvedPath = `${posix.normalize(posix.join(posix.dirname(origin.path), specifier))}.ts`;
  const isScanned = origin.scannedStylesModules.includes(resolvedPath);
  if (!isScanned) throw new Error(`styles reference "${reference}" is imported from ${resolvedPath}, which is not a scanned styles file`);
  return resolvedPath;
}

function stylesheetsOfReference({
  source,
  reference,
  resolving,
  origin,
}: {
  source: string;
  reference: string;
  resolving: Set<string>;
  origin: ImportOrigin;
}): string[] {
  const name = escapedForRegExp(reference);
  const importSpecifier = new RegExp(
    String.raw`import\s*(?:type\s*)?\{[^}]*(?<![\w$])${name}(?![\w$])[^}]*\}\s*from\s*["']([^"']+)["']`,
  ).exec(source)?.[1];
  const isImported = importSpecifier !== undefined;
  if (isImported) {
    scannedStylesModuleOf({ specifier: importSpecifier, reference, origin });
    return [];
  }
  const declaration = new RegExp(String.raw`(?<![\w$])const\s+${name}(?![\w$])[^=;]*=`).exec(source);
  const isResolvable = declaration !== null && !resolving.has(reference);
  if (!isResolvable) throw new Error(`styles reference "${reference}" is neither imported from a scanned styles file nor a constant of the file`);
  const expression = readStylesExpression({ source, start: declaration.index + declaration[0].length });
  return stylesheetsOfExpression({ source, expression, resolving: new Set([...resolving, reference]), origin });
}

function stylesheetsOfExpression({
  source,
  expression,
  resolving,
  origin,
}: {
  source: string;
  expression: StylesExpression;
  resolving: Set<string>;
  origin: ImportOrigin;
}): string[] {
  const referencedStylesheets = expression.references.flatMap((reference) => stylesheetsOfReference({ source, reference, resolving, origin }));
  return [expression.text, ...referencedStylesheets];
}

function stylesWordCountInCode(source: string): number {
  const codeWithoutStrings = sourceWithoutComments({ source, maskStringContents: true });
  const stylesIdentifiers = [...codeWithoutStrings.matchAll(STYLES_IDENTIFIER)].length;
  const stylesStrings = stringLiteralsIn(source).filter((literal) => literal === 'styles').length;
  return stylesIdentifiers + stylesStrings;
}

function stylesPropertyStylesheetsIn({ path, source, scannedStylesModules = [] }: StyleSource): string[] {
  const codeWithoutComments = sourceWithoutComments({ source, maskStringContents: false });
  const declaredStylesProperties = [...codeWithoutComments.matchAll(STYLES_PROPERTY_KEY)].length;
  const extractedStylesArrays = stylesPropertyValueStartsIn(source).map((start) => readStylesValue({ source, start }));
  if (extractedStylesArrays.length !== declaredStylesProperties) {
    throw new Error(`${extractedStylesArrays.length} styles array(s) extracted for ${declaredStylesProperties} styles properties`);
  }
  const stylesWords = stylesWordCountInCode(source);
  if (extractedStylesArrays.length !== stylesWords) {
    throw new Error(`${stylesWords} styles word(s) in code for ${extractedStylesArrays.length} extracted styles array(s)`);
  }
  const origin = { path, scannedStylesModules };
  return extractedStylesArrays
    .flat()
    .flatMap((expression) => stylesheetsOfExpression({ source, expression, resolving: new Set(), origin }));
}

function hostObjectTextsIn(source: string): string[] {
  return [...source.matchAll(HOST_PROPERTY_OPENING)].map((opening) => {
    const start = (opening.index ?? 0) + opening[0].length;
    return source.slice(start, endOfInterpolation({ source, start }));
  });
}

function styleAttributeStylesIn(markup: string): string[] {
  return [...markup.matchAll(INLINE_STYLE_ATTRIBUTE)].map(([, , style]) => style ?? '');
}

function styleBindingStylesIn(source: string): string[] {
  const hostStyles = hostObjectTextsIn(source).flatMap((host) =>
    [...host.matchAll(HOST_STYLE_ENTRY)].map(([, , , style]) => joinedLiterals(style ?? '').replace(OUTER_QUOTES, '')),
  );
  const propertyBindingStyles = [...source.matchAll(INLINE_STYLE_BINDING)].map(
    ([, property, pixelUnit, , value]) => `${property}: ${joinedLiterals(value ?? '')}${pixelUnit ? 'px' : ''}`,
  );
  const styleMapStyles = [...source.matchAll(STYLE_MAP_BINDING)].map(([, , styleMap]) => declarationsOfStyleMap(styleMap ?? ''));
  return [...hostStyles, ...propertyBindingStyles, ...styleMapStyles];
}

function pixelRingsInStyles(styles: string[]): PixelRing[] {
  return styles.flatMap((style) => pixelRingsIn(style));
}

function inlineStylePixelRingsIn(markup: string): PixelRing[] {
  return pixelRingsInStyles([...styleAttributeStylesIn(markup), ...styleBindingStylesIn(markup)]);
}

function inlineStylePixelRingsInTypescript(source: string): PixelRing[] {
  const attributeStyles = stringLiteralsIn(source).flatMap(styleAttributeStylesIn);
  return pixelRingsInStyles([...attributeStyles, ...styleBindingStylesIn(source)]);
}

interface StyleSource {
  path: string;
  source: string;
  scannedStylesModules?: string[];
}

function styleElementsIn(source: string): string[] {
  return [...source.matchAll(STYLE_ELEMENT)].map(([, css]) => withOpaqueInterpolations(css ?? ''));
}

function isStyleConstantFile(path: string): boolean {
  return STYLE_CONSTANT_FILE.test(path) && !path.endsWith('.component.ts') && !path.endsWith('.spec.ts');
}

function stylesheetTextsIn(styleSource: StyleSource): string[] {
  const { path, source } = styleSource;
  if (path.endsWith('.scss')) return [source];
  if (path.endsWith('.html')) return styleElementsIn(source);
  if (isStyleConstantFile(path)) return stringLiteralsIn(source);
  return [...stylesPropertyStylesheetsIn(styleSource), ...styleElementsIn(source)];
}

function inlineRingsInFile({ path, source }: StyleSource): PixelRing[] {
  if (path.endsWith('.scss')) return [];
  if (path.endsWith('.html')) return inlineStylePixelRingsIn(source);
  return inlineStylePixelRingsInTypescript(source);
}

function pixelRingsInFile(styleSource: StyleSource): PixelRing[] {
  const { path } = styleSource;
  const isScss = path.endsWith('.scss');
  try {
    const stylesheetRings = stylesheetTextsIn(styleSource).flatMap((css) => pixelRingsIn(css, { isScss }));
    const inlineRings = inlineRingsInFile(styleSource);
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

function unallowedPixelRingsIn({ allowlist = ELEVATION_SHADOW_ALLOWED, ...styleSource }: StyleSource & { allowlist?: ElevationShadowAllowance[] }): PixelRing[] {
  const isAllowedElevation = ({ selector, declaration }: PixelRing) =>
    allowlist
      .filter(isNamed)
      .some((allowance) => allowance.path === styleSource.path && allowance.selector === selector && allowance.declaration === declaration);
  return pixelRingsInFile(styleSource).filter((ring) => !isAllowedElevation(ring));
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

function htmlSources(): StyleSource[] {
  return sourcesEndingWith('.html');
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
  const scannedStepPanelStyles = ['ui/step-panel.styles.ts'];
  const ringsOfComponent = (source: string, scannedStylesModules: string[] = scannedStepPanelStyles) =>
    pixelRingsInFile({ path: componentPath, source, scannedStylesModules });

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

  it('fails closed when a styles key inside a string differs from the extracted arrays', () => {
    const source = "const note = 'styles: []'; @Component({ styles: [`.a { color: red }`] })";

    expect(() => ringsOfComponent(source)).toThrow(/1 styles array.*2 styles propert/);
  });

  it('ignores a styles word written in a comment', () => {
    const source = `/* styles: [] */ // styles\n@Component({ styles: [\`${focusRing}\`] })`;

    expect(ringsOfComponent(source)).toEqual(focusRingFinding);
  });

  it.each([
    ['a block comment between the key and the colon', `@Component({ styles /* c */ : [\`${focusRing}\`] })`],
    ['a line comment between the key and the colon', `@Component({ styles // c\n : [\`${focusRing}\`] })`],
    ['a computed single-quoted key', `@Component({ ['styles']: [\`${focusRing}\`] })`],
    ['a computed double-quoted key', `@Component({ ["styles"]: [\`${focusRing}\`] })`],
    ['a quoted key and a comment before the colon', `@Component({ 'styles' /* c */ : [\`${focusRing}\`] })`],
  ])('reads a styles key written with %s', (_name, source) => {
    expect(ringsOfComponent(source)).toEqual(focusRingFinding);
  });

  it.each([
    ['a shorthand property', '@Component({ styles })'],
    ['a computed identifier key', '@Component({ [styles]: [`.a { color: red }`] })'],
    ['a destructuring', 'const { styles } = compiled;'],
  ])('fails closed on %s that no styles array is extracted for', (_name, source) => {
    expect(() => ringsOfComponent(source)).toThrow(/1 styles word.*0 extracted styles array/);
  });

  it('accepts a styles property read from an object', () => {
    const source = `const compiledStyles = compiled.styles; @Component({ styles: [\`${focusRing}\`] })`;

    expect(ringsOfComponent(source)).toEqual(focusRingFinding);
  });
});

describe('the styles imports', () => {
  const componentPath = 'ui/x.component.ts';
  const ringsOfComponent = ({ source, scannedStylesModules }: { source: string; scannedStylesModules: string[] }) =>
    pixelRingsInFile({ path: componentPath, source, scannedStylesModules });

  it('accepts an import resolving to a scanned styles file in a parent directory', () => {
    const source = "import { FOO_STYLES } from '../shared/foo-styles'; @Component({ styles: [FOO_STYLES] })";

    expect(ringsOfComponent({ source, scannedStylesModules: ['shared/foo-styles.ts'] })).toEqual([]);
  });

  it('fails closed on an import from a styles-named module that is not scanned', () => {
    const source = "import { FOO_STYLES } from '../shared/foo-styles'; @Component({ styles: [FOO_STYLES] })";

    expect(() => ringsOfComponent({ source, scannedStylesModules: ['ui/step-panel.styles.ts'] })).toThrow(/shared\/foo-styles\.ts.*not a scanned styles file/);
  });

  it('fails closed on an import from a package whose name contains styles', () => {
    const source = "import { FOO_STYLES } from '@x/design-styles'; @Component({ styles: [FOO_STYLES] })";

    expect(() => ringsOfComponent({ source, scannedStylesModules: ['ui/design-styles.ts'] })).toThrow(/package "@x\/design-styles"/);
  });

  it('fails closed on an import from a sibling styles module that is not scanned', () => {
    const source = "import { PANEL } from './panel.styles'; @Component({ styles: [PANEL] })";

    expect(() => ringsOfComponent({ source, scannedStylesModules: [] })).toThrow(/ui\/panel\.styles\.ts.*not a scanned styles file/);
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

  it.each([
    ['a host attr style key', `host: { '[attr.style]': "'outline: 2px solid red'" }`, 'outline: 2px solid red'],
    ['a host style map key', `host: { '[style]': "'outline: 2px solid red'" }`, 'outline: 2px solid red'],
    ['a host ngStyle key', `host: { '[ngStyle]': "{ outline: '2px solid red' }" }`, 'outline: 2px solid red'],
  ])('flags %s sized in pixels exactly once', (_name, source, declaration) => {
    expect(inlineDeclarationsIn(source)).toEqual([declaration]);
  });

  it.each([
    ['a key ending in style', `host: { 'foo-style': 'outline: 2px solid red' }`],
    ['a data-style key', `host: { 'data-style': "box-shadow: 0 0 0 3px red" }`],
    ['a bracketed key ending in style', `host: { '[foo-style]': 'outline: 2px solid red' }`],
  ])('accepts a host entry with %s', (_name, source) => {
    expect(inlineDeclarationsIn(source)).toEqual([]);
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

describe('the style attribute scope', () => {
  const ringsOfComponent = (source: string) => pixelRingsInFile({ path: 'ui/x.component.ts', source });

  it('ignores a variable named style assigned in typescript code', () => {
    const source = "let style = ''; style = 'outline: 2px solid red';";

    expect(ringsOfComponent(source)).toEqual([]);
  });

  it('flags a style attribute inside a single-quoted markup string', () => {
    const source = `const markup = '<i style="outline: 2px solid red"></i>';`;

    expect(ringsOfComponent(source)).toEqual([{ selector: '', declaration: 'outline: 2px solid red' }]);
  });

  it('flags a style attribute inside a template string exactly once', () => {
    const source = '@Component({ template: `<i style="outline: 2px solid red"></i>` })';

    expect(ringsOfComponent(source)).toEqual([{ selector: '', declaration: 'outline: 2px solid red' }]);
  });
});

describe('the html files', () => {
  const ringsOfIndex = (source: string) => pixelRingsInFile({ path: 'index.html', source });

  it('flags an inline style attribute of an index html file', () => {
    expect(ringsOfIndex('<body style="box-shadow: 0 0 0 3px red"></body>')).toEqual([{ selector: '', declaration: 'box-shadow: 0 0 0 3px red' }]);
  });

  it('flags a style element of an index html file', () => {
    const source = '<head><style>.a:focus-visible { outline: 2px solid red }</style></head>';

    expect(ringsOfIndex(source)).toEqual([{ selector: '.a:focus-visible', declaration: 'outline: 2px solid red' }]);
  });

  it('accepts an index html file sized in rem', () => {
    const source = '<head><style>.a:focus-visible { outline: .125rem solid red }</style></head><body style="box-shadow: inset 0 0 0 1px red"></body>';

    expect(ringsOfIndex(source)).toEqual([]);
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
  const htmlFiles = htmlSources();
  const globalStylesheets = globalStylesheetSources();
  const styleConstants = styleConstantSources();
  const scannedStylesModules = styleConstants.map(({ path }) => path);
  const withScannedStylesModules = (styleSource: StyleSource): StyleSource => ({ ...styleSource, scannedStylesModules });

  it('lists the html files it scans, the index page included', () => {
    expect(htmlFiles.map(({ path }) => path)).toContain('index.html');
  });

  it('lists the components it scans', () => {
    expect(components.length).toBeGreaterThan(50);
  });

  it('lists the style constant files it scans', () => {
    expect(styleConstants.map(({ path }) => path).sort()).toEqual(['app/onboarding/step-panel.styles.ts', 'app/settings/settings-value-styles.ts']);
  });

  it.each(['daemon-step', 'project-step', 'first-session-step'])('reads the inline css of the %s onboarding component', (name) => {
    const path = `app/onboarding/${name}.component.ts`;
    const component = components.find((candidate) => candidate.path === path);

    expect(stylesheetTextsIn(withScannedStylesModules(component as StyleSource)).join('\n')).toContain(':host');
  });

  it('reads the focus rules of the daemon step styles array', () => {
    const component = components.find(({ path }) => path === 'app/onboarding/daemon-step.component.ts');

    const stylesheets = stylesheetTextsIn(withScannedStylesModules(component as StyleSource)).join('\n');

    expect(stylesheets).toContain('h2:focus-visible');
    expect(stylesheets).toContain('.last-line:focus-visible');
  });

  it('lists the global stylesheets it scans', () => {
    expect(globalStylesheets.length).toBeGreaterThanOrEqual(1);
    expect(globalStylesheets.map(({ path }) => path)).toContain('styles.scss');
  });

  it('size every outline, outline offset, box-shadow, drop-shadow and ring property in rem', () => {
    const pixelRings = [...components, ...htmlFiles, ...globalStylesheets, ...styleConstants].flatMap((styleSource) =>
      unallowedPixelRingsIn(withScannedStylesModules(styleSource)).map(({ selector, declaration }) => `${styleSource.path}: ${selector} { ${declaration} }`),
    );

    expect(pixelRings).toEqual([]);
  });

  it('ship their styles inline, where the scan and the unit spec can read them', () => {
    const componentsWithExternalStylesheet = components.filter(({ source }) => EXTERNAL_STYLESHEET.test(source)).map(({ path }) => path);

    expect(componentsWithExternalStylesheet).toEqual([]);
  });
});
