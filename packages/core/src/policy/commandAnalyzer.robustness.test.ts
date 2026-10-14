import { describe, expect, it } from 'vitest';
import * as analyzerModule from './commandAnalyzer.js';
import { analyzeCommand, MAX_COMMAND_CHARS } from './commandAnalyzer.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';
import { bashRequest } from './policyRequest.testkit.js';

const RANDOM_INPUT_COUNT = 1000;
const LARGE_INPUT_EVERY = 25;
const SHELL_ALPHABET = [
  ...`'"\`$(){}[]<>|&;!#\\ \t\n=-*?~/.:,`, 'a', 'b', 'rm', ' -rf ', 'sh -c ', '$(', '<<', 'EOF', '\n', "'", '"', '`', '))', '((', '${', ';;',
];

const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};

const randomShellText = (random: () => number, length: number): string => {
  const pieces: string[] = [];
  let produced = 0;
  while (produced < length) {
    const piece = SHELL_ALPHABET[Math.floor(random() * SHELL_ALPHABET.length)] as string;
    pieces.push(piece);
    produced += piece.length;
  }
  return pieces.join('').slice(0, length);
};

const randomInputs = (): string[] => {
  const random = seededRandom(20261014);
  return Array.from({ length: RANDOM_INPUT_COUNT }, (_, index) => {
    const isLarge = index % LARGE_INPUT_EVERY === 0;
    const length = isLarge ? Math.floor(random() * (MAX_COMMAND_CHARS + 1)) : Math.floor(random() * 300);
    return randomShellText(random, length);
  });
};

const exportedFunctions = Object.entries(analyzerModule).filter(([, value]) => typeof value === 'function') as [string, (text: string) => unknown][];

describe('the analyzer on hostile input', () => {
  it('exports analyzeCommand as a function', () => {
    expect(exportedFunctions.map(([name]) => name)).toContain('analyzeCommand');
  });

  it.each(exportedFunctions)('%s never throws on 1000 random inputs up to 64 KiB', (_name, exported) => {
    for (const input of randomInputs()) {
      expect(() => exported(input)).not.toThrow();
    }
  });

  it('returns a well-formed analysis for every random input', () => {
    for (const input of randomInputs()) {
      const analysis = analyzeCommand(input);

      expect(['complete', 'partial', 'limit_exceeded']).toContain(analysis.status);
      expect(analysis.commands.every((command) => command.program.length > 0 && Array.isArray(command.args))).toBe(true);
    }
  });

  it('evaluates every random input without failing', () => {
    for (const input of randomInputs().slice(0, 300)) {
      expect(() => evaluateCommandPolicy(bashRequest(input), DEFAULT_COMMAND_POLICY)).not.toThrow();
    }
  });

  it.each([
    ['unclosed parentheses', '('.repeat(MAX_COMMAND_CHARS)],
    ['unclosed substitutions', '$('.repeat(MAX_COMMAND_CHARS / 2)],
    ['nested closed substitutions', `${'$('.repeat(20_000)}x${')'.repeat(20_000)}`],
    ['unclosed backticks', '`'.repeat(MAX_COMMAND_CHARS)],
    ['unclosed single quotes', "'".repeat(MAX_COMMAND_CHARS)],
    ['unclosed double quotes with substitutions', '"$('.repeat(MAX_COMMAND_CHARS / 3)],
    ['many heredoc operators', '<<A '.repeat(MAX_COMMAND_CHARS / 4)],
    ['unclosed braces', '${'.repeat(MAX_COMMAND_CHARS / 2)],
    ['one separator after another', ';|&'.repeat(MAX_COMMAND_CHARS / 3)],
    ['nested inline shells', "sh -c '".repeat(10_000)],
    ['a long run of backslashes', '\\'.repeat(MAX_COMMAND_CHARS)],
  ])('terminates quickly on %s', (_label, input) => {
    const startedAt = performance.now();

    expect(() => analyzeCommand(input.slice(0, MAX_COMMAND_CHARS))).not.toThrow();

    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('never promotes a separator written inside single quotes', () => {
    const random = seededRandom(7);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const quotedText = randomShellText(random, Math.floor(random() * 40)).replaceAll("'", '');

      const commands = analyzeCommand(`echo '${quotedText}'`).commands;

      expect(commands).toHaveLength(1);
      expect(commands[0]?.args).toEqual([quotedText]);
    }
  });

  it('never promotes a separator written inside double quotes', () => {
    const separators = [';', '&&', '||', '|', '&', '\n', '(', ')', '>', '#'];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const separator = separators[attempt % separators.length] as string;

      const commands = analyzeCommand(`echo "a${separator}b ${separator} c"`).commands;

      expect(commands).toHaveLength(1);
      expect(commands[0]?.program).toBe('echo');
    }
  });
});
