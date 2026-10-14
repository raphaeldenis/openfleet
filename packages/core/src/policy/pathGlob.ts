const ROOT_SEGMENT = '/';

function segmentsOf(path: string): string[] {
  const named = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  return path.startsWith('/') ? [ROOT_SEGMENT, ...named] : named;
}

/** Matches one path segment against a pattern segment where `*` stands for any run of characters and `?` for one. */
function segmentMatches(pattern: string, text: string): boolean {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;
  while (textIndex < text.length) {
    const patternCharacter = pattern[patternIndex];
    if (patternCharacter === '*') {
      starIndex = patternIndex;
      starTextIndex = textIndex;
      patternIndex += 1;
    } else if (patternCharacter !== undefined && (patternCharacter === '?' || patternCharacter === text[textIndex])) {
      patternIndex += 1;
      textIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starTextIndex += 1;
      textIndex = starTextIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

/**
 * Matches a path against a restricted glob: segments are compared one by one, `*` and `?` stay inside a segment and a
 * `**` segment stands for any number of segments. Linear in pattern size times path size, with no backtracking.
 */
export function globMatches(pattern: string, path: string): boolean {
  const patternSegments = segmentsOf(pattern);
  const pathSegments = segmentsOf(path);
  let previous = Array.from({ length: pathSegments.length + 1 }, (_, length) => length === 0);
  for (const patternSegment of patternSegments) {
    const current = [patternSegment === '**' && (previous[0] as boolean)];
    for (let length = 1; length <= pathSegments.length; length += 1) {
      const pathSegment = pathSegments[length - 1] as string;
      current[length] = patternSegment === '**'
        ? (previous[length] as boolean) || (current[length - 1] as boolean)
        : (previous[length - 1] as boolean) && segmentMatches(patternSegment, pathSegment);
    }
    previous = current;
  }
  return previous[pathSegments.length] as boolean;
}
