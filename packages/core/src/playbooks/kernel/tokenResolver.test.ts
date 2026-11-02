import { describe, expect, it } from 'vitest';
import { KernelError } from './kernelError.js';
import { type ResolutionScope, type TemplateSlot, assertResolvedHeadersAreSafe, assertTemplateAllowed, findTemplateViolations, resolveHttpUrl, resolveTemplate } from './tokenResolver.js';

const codeOfThrown = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof KernelError ? error.code : 'not_a_kernel_error';
  }
  return undefined;
};

const secretsByName: Record<string, string> = { JIRA_TOKEN: 'value-of-the-jira-token' };

const scope: ResolutionScope = {
  inputs: { branch: 'main', retries: 3, nested: { deep: 'down' } },
  steps: { build: { sha: 'abc123', report: { ok: true } }, fetch: { title: 'Fix {{secret:JIRA_TOKEN}}' } },
  item: 'row-7',
  index: 0,
  secretValueOf: (name) => secretsByName[name],
};

describe('resolveTemplate', () => {
  it('returns a template without token unchanged', () => {
    expect(resolveTemplate({ template: 'plain text { } {x}', scope }).text).toBe('plain text { } {x}');
  });

  it('resolves an input', () => {
    expect(resolveTemplate({ template: 'git checkout {{inputs.branch}}', scope }).text).toBe('git checkout main');
  });

  it('resolves a nested input and writes a number as text', () => {
    expect(resolveTemplate({ template: '{{inputs.nested.deep}}/{{inputs.retries}}', scope }).text).toBe('down/3');
  });

  it('resolves a field of a step output, nested fields included', () => {
    expect(resolveTemplate({ template: '{{steps.build.sha}} {{steps.build.report.ok}}', scope }).text).toBe('abc123 true');
  });

  it('resolves the item and the index, index 0 included', () => {
    expect(resolveTemplate({ template: '{{item}}#{{index}}', scope }).text).toBe('row-7#0');
  });

  it('writes an object value as canonical JSON', () => {
    expect(resolveTemplate({ template: '{{inputs.nested}}', scope }).text).toBe('{"deep":"down"}');
  });

  it('tolerates spaces inside the braces', () => {
    expect(resolveTemplate({ template: '{{ inputs.branch }}', scope }).text).toBe('main');
  });

  it('resolves a secret and reports its name once, however many times it is used', () => {
    const resolution = resolveTemplate({ template: '{{secret:JIRA_TOKEN}}-{{secret:JIRA_TOKEN}}', scope });

    expect(resolution.text).toBe('value-of-the-jira-token-value-of-the-jira-token');
    expect(resolution.secretNames).toEqual(['JIRA_TOKEN']);
  });

  it('reports no secret name when none is used', () => {
    expect(resolveTemplate({ template: '{{inputs.branch}}', scope }).secretNames).toEqual([]);
  });

  it('never expands a token that a resolved value contains', () => {
    const resolution = resolveTemplate({ template: '{{steps.fetch.title}}', scope });

    expect(resolution.text).toBe('Fix {{secret:JIRA_TOKEN}}');
    expect(resolution.secretNames).toEqual([]);
  });

  it('leaves an unterminated opening as text', () => {
    expect(resolveTemplate({ template: 'a {{inputs.branch', scope }).text).toBe('a {{inputs.branch');
  });

  it.each([
    ['an input that is absent', '{{inputs.missing}}'],
    ['a step that did not run', '{{steps.ghost.sha}}'],
    ['a field the step did not output', '{{steps.build.nothing}}'],
    ['an item outside a loop', '{{item}}'],
    ['an index outside a loop', '{{index}}'],
  ])('refuses %s with unresolved_reference', (_label, template) => {
    const outsideALoop: ResolutionScope = { ...scope, item: undefined, index: undefined };

    expect(codeOfThrown(() => resolveTemplate({ template, scope: outsideALoop }))).toBe('unresolved_reference');
  });

  it('refuses a secret that holds no value with secret_missing', () => {
    expect(codeOfThrown(() => resolveTemplate({ template: '{{secret:NOT_SET}}', scope }))).toBe('secret_missing');
  });

  it.each(['{{foo.bar}}', '{{steps.build}}', '{{steps..x}}', '{{inputs}}', '{{inputs.a b}}', '{{}}', '{{inputs.__proto__}}x{{item.x}}'])('refuses the token in %s with unknown_token', (template) => {
    expect(codeOfThrown(() => resolveTemplate({ template, scope }))).toBe('unknown_token');
  });

  it.each(['{{secret:}}', '{{secret:bad name}}', '{{secret:1ABC}}', '{{secret:A-B}}'])('refuses the secret name in %s with invalid_secret_name', (template) => {
    expect(codeOfThrown(() => resolveTemplate({ template, scope }))).toBe('invalid_secret_name');
  });
});

describe('findTemplateViolations: secret tokens', () => {
  const violationCodesOf = (slot: TemplateSlot, template: string) => findTemplateViolations({ template, slot }).map((violation) => violation.code);

  it.each(['script_env', 'http_headers', 'http_auth'] as const)('accepts {{secret:..}} in %s', (slot) => {
    expect(violationCodesOf(slot, '{{secret:JIRA_TOKEN}}')).toEqual([]);
  });

  it.each(['script_args', 'http_url', 'http_body', 'text'] as const)('refuses {{secret:..}} in %s with secret_not_allowed_here', (slot) => {
    expect(violationCodesOf(slot, 'https://host/x {{secret:JIRA_TOKEN}}')).toEqual(['secret_not_allowed_here']);
  });

  it('names the offending token and the slot', () => {
    expect(findTemplateViolations({ template: 'a {{ secret:JIRA_TOKEN }}', slot: 'text' })).toEqual([
      { code: 'secret_not_allowed_here', token: '{{ secret:JIRA_TOKEN }}', slot: 'text' },
    ]);
  });

  it('accepts a template without any token in every slot', () => {
    expect(violationCodesOf('script_args', 'plain')).toEqual([]);
  });
});

describe('findTemplateViolations: untrusted references', () => {
  const untrusted = { stepIds: new Set(['llm', 'http_call']), isItemUntrusted: false };
  const violationCodesOf = (slot: TemplateSlot, template: string, rule = untrusted) => findTemplateViolations({ template, slot, untrusted: rule }).map((violation) => violation.code);

  it.each(['script_args', 'script_env', 'http_headers', 'http_auth'] as const)('refuses a step output of an untrusted step in %s', (slot) => {
    expect(violationCodesOf(slot, '{{steps.llm.answer}}')).toEqual(['untrusted_reference']);
  });

  it.each(['http_body', 'text'] as const)('accepts a step output of an untrusted step in %s', (slot) => {
    expect(violationCodesOf(slot, '{{steps.llm.answer}}')).toEqual([]);
  });

  it('accepts a step output of a trusted step in every checked slot', () => {
    expect(violationCodesOf('script_args', '{{steps.build.sha}}')).toEqual([]);
  });

  it('accepts inputs in every checked slot', () => {
    expect(violationCodesOf('script_env', '{{inputs.branch}}')).toEqual([]);
  });

  it('refuses the item in a checked slot when the loop iterates untrusted data', () => {
    expect(violationCodesOf('script_args', '{{item}}', { stepIds: new Set(), isItemUntrusted: true })).toEqual(['untrusted_reference']);
  });

  it('accepts the item when the loop iterates trusted data', () => {
    expect(violationCodesOf('script_args', '{{item}}')).toEqual([]);
  });

  describe('in a URL, only the host part is checked', () => {
    it('refuses an untrusted reference in the host', () => {
      expect(violationCodesOf('http_url', 'https://{{steps.llm.host}}/api')).toEqual(['untrusted_reference']);
    });

    it('refuses an untrusted reference that makes up the whole URL', () => {
      expect(violationCodesOf('http_url', '{{steps.http_call.url}}/api')).toEqual(['untrusted_reference']);
    });

    it('refuses an untrusted reference in the userinfo and the port', () => {
      expect(violationCodesOf('http_url', 'https://{{steps.llm.user}}@host:{{steps.llm.port}}/api')).toEqual(['untrusted_reference', 'untrusted_reference']);
    });

    it.each(['https://jira.example.com/{{steps.llm.key}}', 'https://jira.example.com/rest?q={{steps.llm.query}}', 'https://jira.example.com#{{steps.llm.anchor}}'])(
      'accepts an untrusted reference after the host in %s',
      (template) => {
        expect(violationCodesOf('http_url', template)).toEqual([]);
      },
    );

    it('accepts a trusted reference in the host', () => {
      expect(violationCodesOf('http_url', 'https://{{inputs.host}}/api')).toEqual([]);
    });
  });
});

describe('findTemplateViolations: the authority of a URL is canonical', () => {
  const untrusted = { stepIds: new Set(['bad', 'llm']), isItemUntrusted: false };
  const violationCodesOf = (template: string) => findTemplateViolations({ template, slot: 'http_url', untrusted }).map((violation) => violation.code);

  it.each([
    ['one slash too many', 'https:///{{steps.bad.host}}/'],
    ['one slash too few', 'https:/{{steps.bad.host}}/'],
    ['a scheme-relative URL', '//{{steps.bad.host}}/'],
    ['backslashes instead of slashes', 'https:\\\\{{steps.bad.host}}/'],
    ['an uppercase scheme with one slash too many', 'HTTPS:///{{steps.bad.host}}/'],
    ['a tab inside the scheme', 'ht\ttps://{{steps.bad.host}}/'],
    ['a newline before the host', 'https://\n{{steps.bad.host}}/'],
    ['a carriage return after the host', 'https://{{steps.bad.host}}\r/'],
    ['no host at all', 'https://'],
    ['a path right after the scheme', 'https://?x={{steps.bad.host}}'],
    ['a backslash in the host', 'https://{{inputs.host}}\\@evil.example/'],
    ['a literal before the first token that is no scheme', 'x{{steps.bad.url}}'],
    ['trusted tokens only, behind one slash too many', 'https:///{{inputs.host}}/'],
  ])('refuses %s with non_canonical_url', (_label, template) => {
    expect(violationCodesOf(template)).toEqual(['non_canonical_url']);
  });

  it('judges the authority without any untrusted rule', () => {
    expect(findTemplateViolations({ template: 'https:///{{inputs.host}}/', slot: 'http_url' }).map((violation) => violation.code)).toEqual(['non_canonical_url']);
  });

  it('does not judge the authority of other slots', () => {
    expect(findTemplateViolations({ template: '//{{inputs.host}}', slot: 'http_body' })).toEqual([]);
  });

  it.each([
    'https://{{inputs.host}}:8080/api',
    'https://[::1]:8080/{{steps.llm.key}}',
    'HTTPS://jira.example.com/{{steps.llm.key}}',
    'https://user%40x:pw@jira.example.com/{{steps.llm.key}}',
    '{{inputs.baseUrl}}/api',
  ])('accepts the canonical authority of %s', (template) => {
    expect(violationCodesOf(template)).toEqual([]);
  });

  it.each([
    ['an encoded @ followed by an untrusted token', 'https://a%40{{steps.bad.x}}@good.example/'],
    ['an untrusted token in an IPv6 literal', 'https://[{{steps.bad.ip}}]:443/'],
    ['an untrusted token in the port', 'https://good.example:{{steps.bad.port}}/'],
  ])('keeps refusing %s as untrusted_reference', (_label, template) => {
    expect(violationCodesOf(template)).toEqual(['untrusted_reference']);
  });
});

describe('resolveHttpUrl', () => {
  const urlScope: ResolutionScope = {
    inputs: { host: 'jira.example.com', port: 8443, base: 'https://jira.example.com', schemeless: 'jira.example.com', slashedHost: '/evil.example', tabbedHost: 'jira\t.evil.example' },
    steps: { llm: { key: '@evil.example', tabbed: 'a\tb\nc' } },
    secretValueOf: () => undefined,
  };
  const untrusted = { stepIds: new Set(['llm']), isItemUntrusted: false };
  const resolveUrl = (template: string) => resolveHttpUrl({ template, scope: urlScope, untrusted });

  it('returns the URL as the HTTP client parses it', () => {
    expect(resolveUrl('https://{{inputs.host}}:{{inputs.port}}/rest')).toBe('https://jira.example.com:8443/rest');
  });

  it('accepts a template made of a trusted base URL', () => {
    expect(resolveUrl('{{inputs.base}}/rest')).toBe('https://jira.example.com/rest');
  });

  it('keeps an untrusted value that looks like userinfo inside the path', () => {
    expect(resolveUrl('https://jira.example.com/{{steps.llm.key}}')).toBe('https://jira.example.com/@evil.example');
  });

  it('returns what the parser keeps of an untrusted value holding tabs and newlines', () => {
    expect(resolveUrl('https://jira.example.com/{{steps.llm.tabbed}}')).toBe('https://jira.example.com/abc');
  });

  it('refuses an untrusted token in the authority', () => {
    expect(codeOfThrown(() => resolveUrl('https://{{steps.llm.key}}/rest'))).toBe('untrusted_reference');
  });

  it('refuses a template whose authority is not canonical', () => {
    expect(codeOfThrown(() => resolveUrl('https:///{{inputs.host}}/rest'))).toBe('non_canonical_url');
  });

  it('refuses a trusted value that opens a second slash after the scheme', () => {
    expect(codeOfThrown(() => resolveUrl('https://{{inputs.slashedHost}}/rest'))).toBe('non_canonical_url');
  });

  it('refuses a trusted value holding a tab in the host', () => {
    expect(codeOfThrown(() => resolveUrl('https://{{inputs.tabbedHost}}/rest'))).toBe('non_canonical_url');
  });

  it('refuses a trusted base URL that holds no scheme', () => {
    expect(codeOfThrown(() => resolveUrl('{{inputs.schemeless}}/rest'))).toBe('non_canonical_url');
  });

  it('refuses a secret in the URL', () => {
    expect(codeOfThrown(() => resolveUrl('https://jira.example.com/{{secret:JIRA_TOKEN}}'))).toBe('secret_not_allowed_here');
  });

  it('refuses a reference to nothing', () => {
    expect(codeOfThrown(() => resolveUrl('https://{{inputs.absent}}/'))).toBe('unresolved_reference');
  });
});

describe('assertResolvedHeadersAreSafe', () => {
  it('accepts ordinary headers, a tab in a value included', () => {
    expect(() => assertResolvedHeadersAreSafe({ Accept: 'application/json', 'X-Note': 'a\tb', Authorization: 'Bearer abc.def' })).not.toThrow();
  });

  it('accepts no header at all', () => {
    expect(() => assertResolvedHeadersAreSafe({})).not.toThrow();
  });

  it.each([
    ['a CRLF followed by another header', { 'X-Trace': 'abc\r\nX-Injected: 1' }],
    ['a lone LF', { 'X-Trace': 'abc\nX-Injected: 1' }],
    ['a lone CR', { 'X-Trace': 'abc\rX-Injected: 1' }],
    ['a trailing CRLF', { 'X-Trace': 'abc\r\n' }],
    ['a NUL character', { 'X-Trace': 'abc\u0000def' }],
    ['a line break in the name', { 'X-Trace\r\nX-Injected': '1' }],
  ])('refuses %s with header_injection', (_label, headers) => {
    expect(codeOfThrown(() => assertResolvedHeadersAreSafe(headers))).toBe('header_injection');
  });

  it('refuses the whole set when only the second header is unsafe', () => {
    expect(codeOfThrown(() => assertResolvedHeadersAreSafe({ Accept: 'application/json', 'X-Trace': 'a\nb' }))).toBe('header_injection');
  });

  it('does not repeat the header value in its message', () => {
    const secretLookingValue = ['top', 'secret', 'value'].join('-');
    let message = '';
    try {
      assertResolvedHeadersAreSafe({ 'X-Trace': `${secretLookingValue}\r\nX-Injected: 1` });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain(secretLookingValue);
  });
});

describe('assertTemplateAllowed', () => {
  it('throws the code of the first violation', () => {
    const withBoth = () => assertTemplateAllowed({ template: '{{steps.llm.x}} {{secret:A_SECRET}}', slot: 'script_args', untrusted: { stepIds: new Set(['llm']), isItemUntrusted: false } });

    expect(codeOfThrown(withBoth)).toBe('untrusted_reference');
  });

  it('throws secret_not_allowed_here for a secret outside its slots', () => {
    expect(codeOfThrown(() => assertTemplateAllowed({ template: '{{secret:A_SECRET}}', slot: 'http_body' }))).toBe('secret_not_allowed_here');
  });

  it('throws nothing for an allowed template', () => {
    expect(() => assertTemplateAllowed({ template: '{{secret:A_SECRET}}', slot: 'script_env' })).not.toThrow();
  });

  it('throws unknown_token for a malformed token, before judging the slot', () => {
    expect(codeOfThrown(() => assertTemplateAllowed({ template: '{{nope}}', slot: 'script_env' }))).toBe('unknown_token');
  });
});
