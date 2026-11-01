import { describe, expect, it } from 'vitest';
import { maskedCommandSecrets } from './commandSecrets.js';

describe('maskedCommandSecrets hides the secret a command line carries', () => {
  it.each([
    ['rm -rf s5 --password hunter2plain', 'rm -rf s5 --password ***'],
    ['rm -rf s5 --password=hunter2plain', 'rm -rf s5 --password=***'],
    ['tool --passwd hunter2plain', 'tool --passwd ***'],
    ['tool --passwd=hunter2plain', 'tool --passwd=***'],
    ['tool --secret hunter2plain', 'tool --secret ***'],
    ['tool --secret=hunter2plain', 'tool --secret=***'],
    ['tool --api-key hunter2plain', 'tool --api-key ***'],
    ['tool --api-key=hunter2plain', 'tool --api-key=***'],
    ['tool --apikey hunter2plain', 'tool --apikey ***'],
    ['tool --apikey=hunter2plain', 'tool --apikey=***'],
    ['tool --token hunter2plain', 'tool --token ***'],
    ['tool --token=hunter2plain', 'tool --token=***'],
    ['tool --auth hunter2plain', 'tool --auth ***'],
    ['tool --auth=hunter2plain', 'tool --auth=***'],
    ['tool --db-password "hunter two"', 'tool --db-password ***'],
    ["tool --password 'hunter two' --force", 'tool --password *** --force'],
    ['PASSWORD=hunter2plain deploy.sh', 'PASSWORD=*** deploy.sh'],
    ['export TOKEN=hunter2plain', 'export TOKEN=***'],
    ['API_KEY="hunter two" run', 'API_KEY=*** run'],
    ['git clone https://alice:hunter2plain@example.com/repo.git', 'git clone https://***@example.com/repo.git'],
    ['curl -H "Authorization: Bearer hunter2plain" https://example.com', 'curl -H "Authorization: Bearer ***" https://example.com'],
    ['mysql -u root -phunter2plain shop', 'mysql -u root -p*** shop'],
    ['mysqldump -phunter2plain shop', 'mysqldump -p*** shop'],
    ['sshpass -p hunter2plain ssh host', 'sshpass -p *** ssh host'],
    ['redis-cli -a hunter2plain ping', 'redis-cli -a *** ping'],
    ['curl -u alice:hunter2plain https://example.com', 'curl -u alice:*** https://example.com'],
  ])('masks the value in %s', (command, expected) => {
    const masked = maskedCommandSecrets(command);

    expect(masked).toBe(expected);
    expect(masked).not.toContain('hunter2plain');
    expect(masked).not.toContain('hunter two');
  });

  describe('an option named after a credential', () => {
    const secretOptionNames = ['token', 'password', 'passwd', 'secret', 'api-key', 'apikey', 'auth', 'authorization', 'bearer'];
    const tokenEqualsValue = ['to', 'ken'].join('') + '=' + ['abc', 'DEF', '123'].join('');
    const longBase64Key = ['QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo', 'wMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5v', 'cHFyc3R1dnd4eXo9PQ'].join('');

    it.each(secretOptionNames.flatMap((name) => [[name, 'space'], [name, 'equals']] as const))('masks the value of --%s given with %s', (name, form) => {
      const command = form === 'space' ? `tool --${name} ${longBase64Key} --force` : `tool --${name}=${longBase64Key} --force`;
      const separator = form === 'space' ? ' ' : '=';

      const masked = maskedCommandSecrets(command);

      expect(masked).toBe(`tool --${name}${separator}*** --force`);
    });

    it('masks a token assignment and a long base64 key given as option values', () => {
      const masked = maskedCommandSecrets(`tool ${tokenEqualsValue} --token ${longBase64Key} --apikey=${longBase64Key}`);

      expect(masked).not.toContain('abcDEF123');
      expect(masked).not.toContain(longBase64Key);
    });
  });

  describe('an authorization option given an unquoted scheme and token', () => {
    const credential = ['abc', '123', 'def'].join('');

    it.each([
      ['Bearer', 'space'],
      ['Bearer', 'equals'],
      ['Basic', 'space'],
      ['Basic', 'equals'],
      ['Token', 'space'],
      ['Token', 'equals'],
    ] as const)('masks the %s scheme and its token given with %s', (scheme, form) => {
      const separator = form === 'space' ? ' ' : '=';
      const command = `curl --authorization${separator}${scheme} ${credential} https://example.com`;

      const masked = maskedCommandSecrets(command);

      expect(masked).toBe(`curl --authorization${separator}*** https://example.com`);
      expect(masked).not.toContain(credential);
    });

    it('masks a quoted scheme and token', () => {
      const masked = maskedCommandSecrets(`curl --authorization "Bearer ${credential}" https://example.com`);

      expect(masked).toBe('curl --authorization *** https://example.com');
    });
  });

  describe('a value the shell reads past an escaped quote, a glued segment or a backslash', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const secret = ['SECRET', 'VALUE', '0042'].join('');

    it('masks the whole double-quoted value past an escaped double quote', () => {
      expect(maskedCommandSecrets(`cmd --password "safe\\" ${secret}" --name keep`)).toBe('cmd --password *** --name keep');
    });

    it('masks the whole value glued from single-quoted segments and an escaped single quote', () => {
      expect(maskedCommandSecrets(`cmd --password 'safe'\\'' ${secret}' --name keep`)).toBe('cmd --password *** --name keep');
    });

    it.each([
      ['an ANSI-C quoted value', `cmd --password $'safe\\' ${secret}' --name keep`],
      ['a space escaped by a backslash', `cmd --password safe\\ ${secret} --name keep`],
      ['the equals form', `cmd --password="safe\\" ${secret}" --name keep`],
      ['a quote glued inside the equals form', `cmd --token=safe"\\" ${secret}" --name keep`],
      ['an assignment', `API_KEY="safe\\" ${secret}" run --name keep`],
      ['an authorization header', `curl -H "Authorization: Bearer safe\\" ${secret}" --name keep`],
      ['an api key header', `curl -H "X-Api-Key: safe\\" ${secret}" --name keep`],
      ['an authorization scheme then a quoted token', `curl --authorization Bearer "safe\\" ${secret}" --name keep`],
      ['a mysql password', `mysql -u root -p"safe\\" ${secret}" --name keep`],
      ['an sshpass password', `sshpass -p 'safe'\\'' ${secret}' ssh host --name keep`],
      ['a redis-cli password', `redis-cli -a "safe\\" ${secret}" --name keep`],
      ['a curl user password', `curl -u "alice:safe\\" ${secret}" --name keep`],
      ['a curl user password given with equals', `curl --user="alice:safe\\" ${secret}" --name keep`],
      ['URL credentials', `git clone "https://alice:safe\\"${secret}@example.com/r.git" --name keep`],
      ['a command given to sh -c', `sh -c "mysql -p'${secret}' db" --name keep`],
      ['a command nested twice', `ssh host "sh -c \\"cmd --token '${secret}'\\"" --name keep`],
      ['a value that runs on to the next line', `cmd --password "safe\n${secret}" --name keep`],
      ['a program on the next line', `echo ok\nmysql -p${secret} db --name keep`],
      ['a quote that never closes', `cmd --name keep --password "safe ${secret}`],
    ])('masks the whole value given through %s', (_label, command) => {
      const masked = maskedCommandSecrets(command);

      expect(masked).not.toContain(secret);
      expect(masked).toContain('--name keep');
    });

    it('keeps a quoted sentence and a quoted command without a secret readable', () => {
      const command = 'git commit -m "fix the parser" && sh -c "echo hello world"';

      expect(maskedCommandSecrets(command)).toBe(command);
    });
  });

  it.each([
    'mkdir -p dir',
    'mkdir -p a/b/c',
    'cp -p a b',
    'ls -p',
    'ls -p /tmp',
    'git commit --author "Alice <a@example.com>"',
    'docker login --password-stdin',
    'rm -rf build',
    'npm run test -- --token-count',
    'git log --author alice',
    'tool --authorization-file ./headers.txt',
    'tool --authorized-keys foo',
    'tool --authentication-agent x',
  ])('leaves %s readable', (command) => {
    expect(maskedCommandSecrets(command)).toBe(command);
  });
});
