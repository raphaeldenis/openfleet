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
    ['tool --password "" --force', 'tool --password *** --force'],
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

  describe('a command substitution', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const secret = ['SEKR', 'ET', '42'].join('');

    it.each([
      ['the value of a secret option', `cmd --password $(printf '${secret}') --name keep`, 'cmd --password *** --name keep'],
      ['the value of a secret option given with equals', `cmd --password=$(printf '${secret}') --name keep`, 'cmd --password=*** --name keep'],
      ['a backtick value of a secret option', `cmd --password=\`printf ${secret}\` --name keep`, 'cmd --password=*** --name keep'],
      ['a quoted substitution value', `cmd --token "$(printf '${secret}')" --name keep`, 'cmd --token *** --name keep'],
      ['a substitution holding a closing parenthesis in quotes', `cmd --token $(printf ')${secret}') --name keep`, 'cmd --token *** --name keep'],
      ['nested substitutions', `cmd --token $(echo $(printf '${secret}')) --name keep`, 'cmd --token *** --name keep'],
      ['the value of a secret assignment', `API_KEY=$(printf '${secret}') run --name keep`, 'API_KEY=*** run --name keep'],
      ['a password program run inside', `echo $(mysql -p${secret} db) --name keep`, 'echo $(mysql -p*** db) --name keep'],
      ['a password program run inside backticks', `echo \`sshpass -p ${secret} ssh host\` --name keep`, 'echo `sshpass -p *** ssh host` --name keep'],
      ['a password program run inside a quoted substitution', `echo "out: $(curl -u alice:${secret} https://example.com)" --name keep`, 'echo "out: $(curl -u alice:*** https://example.com)" --name keep'],
    ])('masks %s', (_label, command, expected) => {
      expect(maskedCommandSecrets(command)).toBe(expected);
    });

    it.each([
      'echo $(date) $((1 + 2))',
      'git log --since="$(date -v-1d)" --oneline',
      'cd "$(git rev-parse --show-toplevel)"',
      'echo `whoami`',
    ])('leaves %s readable', (command) => {
      expect(maskedCommandSecrets(command)).toBe(command);
    });
  });

  describe('a word spelled with ANSI-C escapes', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const secret = ['SEKR', 'ET', '42'].join('');

    it.each([
      ['a hex escape in a header name', `curl -H $'\\x41uthorization: ${secret}' https://example.com`, "curl -H $'\\x41uthorization: ***' https://example.com"],
      ['a short Unicode escape in a header name', `curl -H $'\\u0041uthorization: ${secret}' https://example.com`, "curl -H $'\\u0041uthorization: ***' https://example.com"],
      ['a long Unicode escape in a header name', `curl -H $'\\U00000041uthorization: ${secret}' https://example.com`, "curl -H $'\\U00000041uthorization: ***' https://example.com"],
      ['an octal escape in a header name', `curl -H $'\\101uthorization: ${secret}' https://example.com`, "curl -H $'\\101uthorization: ***' https://example.com"],
      ['a hex escape in a program name', `$'\\x63url' -u alice:${secret} https://example.com`, "$'\\x63url' -u alice:*** https://example.com"],
      ['an octal escape in a program name', `$'\\143url' -u alice:${secret} https://example.com`, "$'\\143url' -u alice:*** https://example.com"],
      ['a hex escape in an option name', `tool $'--to\\x6ben' ${secret} --force`, "tool $'--to\\x6ben' *** --force"],
      ['a hex escape in an assignment name', `$'API\\x5fKEY=${secret}' run`, "$'API\\x5fKEY=***' run"],
    ])('decodes %s before reading it', (_label, command, expected) => {
      expect(maskedCommandSecrets(command)).toBe(expected);
    });

    it('keeps a decoded word without a secret as written', () => {
      const command = "printf $'line\\none\\t\\x41\\101\\u00e9\\\\'";

      expect(maskedCommandSecrets(command)).toBe(command);
    });
  });

  describe('a command nested deeper than the scan reads', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const secret = ['SEKR', 'ET', '42'].join('');
    const DEEPEST_LEVEL_READ = 4;
    const DEEPER_THAN_READ = 5;
    const givenToShC = (command: string) => `sh -c "${command.replace(/[\\"$`]/g, '\\$&')}"`;
    const nestedTimes = (command: string, levels: number) => Array.from({ length: levels }).reduce<string>((inner) => givenToShC(inner), command);
    const nested = (command: string) => nestedTimes(command, DEEPER_THAN_READ);

    it.each([
      ['a program spelled with escapes', `$'\\x63url' -u alice:${secret}`],
      ['a secret option', `tool --token ${secret}`],
      ['a quoted secret value', `tool --name '${secret}'`],
    ])('masks the whole innermost word that holds %s', (_label, command) => {
      const masked = maskedCommandSecrets(nested(command));

      expect(masked).not.toContain(secret);
      expect(masked).toContain('***');
    });

    it('keeps a command at the deepest level read readable when it names no secret and holds no quote', () => {
      const command = nestedTimes('echo hello world', DEEPEST_LEVEL_READ);

      expect(maskedCommandSecrets(command)).toBe(command);
    });

    it('masks a command nested deeper than read even without a secret, since its quoting stays unread', () => {
      const masked = maskedCommandSecrets(nested('echo hello world'));

      expect(masked).not.toContain('hello world');
      expect(masked).toContain('***');
    });
  });

  describe('an option that always takes the next word as its value', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const dashedSecret = ['-SEKR', 'ET', '42'].join('');

    it.each([
      ['sshpass -p', `sshpass -p ${dashedSecret} ssh host`, 'sshpass -p *** ssh host'],
      ['redis-cli -a', `redis-cli -a ${dashedSecret} ping`, 'redis-cli -a *** ping'],
      ['curl -u', `curl -u alice:${dashedSecret} https://example.com`, 'curl -u alice:*** https://example.com'],
      ['--token', `tool --token ${dashedSecret} --force`, 'tool --token *** --force'],
      ['--password', `tool --password ${dashedSecret} --force`, 'tool --password *** --force'],
      ['--api-key', `tool --api-key ${dashedSecret} --force`, 'tool --api-key *** --force'],
      ['--db-password', `tool --db-password ${dashedSecret} --force`, 'tool --db-password *** --force'],
    ])('masks a value of %s that starts with a dash', (_label, command, expected) => {
      expect(maskedCommandSecrets(command)).toBe(expected);
    });

    it.each([
      'tool --token-count --json',
      'tool --no-auth --verbose',
      'tool --auth-type --verbose',
    ])('leaves the next option of %s readable when the option may stand alone', (command) => {
      expect(maskedCommandSecrets(command)).toBe(command);
    });
  });

  describe('the text around a masked value', () => {
    // Built at run time: no token-shaped literal sits in the source.
    const secret = ['SEKR', 'ET', '42'].join('');

    it.each([
      ['an ANSI-C quoted header', `curl -H $'X-Api-Key: ${secret}' https://example.com`, "curl -H $'X-Api-Key: ***' https://example.com"],
      ['a single-quoted header', `curl -H 'Authorization: Bearer ${secret}' https://example.com`, "curl -H 'Authorization: Bearer ***' https://example.com"],
      ['a command given to sh -c', `sh -c "mysql -p'${secret}' db" --name keep`, 'sh -c "mysql -p*** db" --name keep'],
      ['quoted URL credentials', `git clone "https://alice:${secret}@example.com/r.git"`, 'git clone "https://***@example.com/r.git"'],
      ['an assignment inside a quoted sentence, masked to the end of the word', "echo 'API_KEY=example documentation'", "echo 'API_KEY=***'"],
      ['a quoted assignment whose value holds a space', `docker run -e "DB_PASSWORD=${secret} two" image`, 'docker run -e "DB_PASSWORD=***" image'],
      ['a command nested twice', `ssh host "sh -c \\"cmd --token '${secret}'\\"" --name keep`, 'ssh host "sh -c \\"cmd --token ***\\"" --name keep'],
    ])('keeps the quotes and the words around %s', (_label, command, expected) => {
      expect(maskedCommandSecrets(command)).toBe(expected);
    });

    it.each([
      "git log --grep='mysql -pfeature'",
      'git log --grep="sshpass -p feature"',
      "grep -r 'curl -u alice' docs",
    ])('leaves the text of %s readable when no program of its own takes the password', (command) => {
      expect(maskedCommandSecrets(command)).toBe(command);
    });
  });

  describe('a corpus of everyday commands', () => {
    it.each([
      'git status',
      'git commit -m "fix: the parser keeps quotes"',
      'git log --author alice --oneline -5',
      'git config credential.helper osxkeychain',
      'git push origin feat/x',
      'gh pr create --title "feat: x" --body "body text"',
      'gh pr checks 12',
      'curl -s https://example.com/api',
      'curl -H "Accept: application/json" https://example.com',
      'curl -X POST -d \'{"a":1}\' https://example.com',
      'ssh -p 2222 deploy@host uptime',
      'ssh host "ls -la /var/log"',
      'mysql -u root -h db shop',
      'mysql -u root -p shop',
      'docker login --username bob --password-stdin',
      'docker run -e NODE_ENV=production -p 8080:80 image',
      'docker compose up -d',
      'npm run test -- --token-count',
      'npm install --save-dev vitest',
      'npm publish --access public',
      'sshpass -f ./pw ssh host',
      'redis-cli -h cache ping',
      'redis-cli -n 2 keys "*"',
      'mkdir -p a/b/c',
      'ls -p /tmp',
      'cp -p a b',
      'git commit --author "Alice <a@example.com>" -m "x"',
      'echo "hello world" | tr a-z A-Z',
      'find . -name "*.ts" -exec grep -l token {} +',
      'tool --token-count --json',
    ])('leaves %s as it is', (command) => {
      expect(maskedCommandSecrets(command)).toBe(command);
    });
  });

  describe('the cost of masking an adversarial command, uncut', () => {
    const ADVERSARIAL_LENGTH = 100_000;
    // A linear scan takes about 15 ms here and a quadratic one over 600 ms: 100 ms leaves room for a loaded CI machine and still catches the regression.
    const MAX_MILLISECONDS = 100;
    const MEASURES = 3;
    const repeatedTo = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const fastestMilliseconds = (mask: () => unknown) => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let measure = 0; measure < MEASURES; measure += 1) {
        const startedAt = performance.now();
        mask();
        fastest = Math.min(fastest, performance.now() - startedAt);
      }
      return fastest;
    };

    it.each([
      ['curl', 'curl '],
      ['mysql', 'mysql '],
      ['sshpass', 'sshpass '],
      ['redis-cli', 'redis-cli '],
      ['double quotes', '"'],
      ['single quotes', "'"],
      ['escaped double quotes', '\\"'],
      ['ANSI-C quotes', "$'"],
      ['nested sh -c commands', 'sh -c "'],
      ['escaped nested sh -c commands', 'sh -c \\"'],
      ['secret flags', '--token '],
      ['plain words', 'x '],
      ['command substitutions', '$('],
      ['substitutions in double quotes', '"$('],
      ['substitutions behind secret options', '--token $(printf '],
      ['backticks', '`'],
      ['ANSI-C escapes', "$'\\x41"],
    ])('masks %s repeated over 100000 characters in under 100 ms', (_label, unit) => {
      const command = repeatedTo(unit, ADVERSARIAL_LENGTH);

      const milliseconds = fastestMilliseconds(() => maskedCommandSecrets(command));

      expect(milliseconds).toBeLessThan(MAX_MILLISECONDS);
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
