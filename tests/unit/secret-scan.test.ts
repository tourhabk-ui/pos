// @vitest-environment node
/**
 * Сканер секретов на добавленных строках (аудит перед запуском, 22.10).
 *
 * Ключи провайдеров нашлись в публичной истории репозитория, а сканер
 * detect-secrets.sh не звал никто. Теперь один разбор — scripts/security/
 * secret-scan.mjs — зовут хук pre-commit и workflow secret-scan.yml на
 * каждом PR и пуше в main.
 *
 * Сторож держит связку по поведению: каждый род ключа находится, значение не
 * печатается ни целиком, ни частью, судятся только добавленные строки, а сам
 * сканер, запущенный в настоящем git-репозитории, краснеет на ключе,
 * зеленеет без него и честно отвечает «не смог» на битом диапазоне.
 *
 * Ключи собираются при запуске: целиком в исходнике теста их нет, и этот
 * файл сам не попадается своему сканеру.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedLines, scanDiff, SECRET_PATTERNS } from '../../scripts/security/secret-scan.mjs';

const SCRIPT = join(process.cwd(), 'scripts/security/secret-scan.mjs');

/** Синтетический ключ каждого рода — собран из кусков. */
const FAKE: Record<string, string> = {
  'Telegram: токен бота': '123456789' + ':AA' + 'b'.repeat(33),
  'Anthropic: ключ API': 'sk-ant-' + 'api03-' + 'Q'.repeat(40),
  'OpenRouter: ключ API': 'sk-or-' + 'v1-' + 'a1'.repeat(32),
  'OpenAI: ключ проекта': 'sk-' + 'proj-' + 'Z9'.repeat(24),
  'DeepSeek / DashScope: ключ API': 'sk-' + '0f'.repeat(16),
  'xAI: ключ API': 'xai-' + 'K7'.repeat(30),
  'GitHub: токен': 'ghp' + '_' + 'R'.repeat(36),
  'AWS / S3: ключ доступа': 'AKIA' + 'Q'.repeat(16),
  'Google: ключ API': 'AIza' + 'S'.repeat(35),
  'Яндекс Облако: API-ключ': 'AQVN' + 'y'.repeat(40),
  'Яндекс: OAuth-токен': 'y0' + '_' + 'Ag'.repeat(30),
  'CloudPayments: секрет': 'cp-' + 'ab'.repeat(16),
  'JWT': 'eyJhbG' + 'ciOi' + 'x'.repeat(120),
  'Закрытый ключ': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'Строка подключения с паролем': 'postgresql://app' + ':Zq7rT9vK2w' + '@db.internal:5432/main',
};

/** Unified diff с одним новым файлом и заданными строками. */
function diffOf(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

describe('каждый род ключа находится', () => {
  it('у каждого шаблона есть синтетический ключ — список не разошёлся', () => {
    expect(Object.keys(FAKE).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort());
  });

  it.each(Object.entries(FAKE))('%s', (name, key) => {
    const findings = scanDiff(diffOf('config/app.ts', [`export const K = '${key}';`]));
    expect(findings.map((f) => f.name)).toContain(name);
    expect(findings[0]).toMatchObject({ file: 'config/app.ts', line: 1 });
  });
});

describe('судятся только добавленные строки', () => {
  it('удалённая и неизменённая строка с ключом — не находка, номер строки — по новой версии', () => {
    const key = FAKE['OpenRouter: ключ API'];
    const diff = [
      'diff --git a/lib/a.ts b/lib/a.ts',
      '--- a/lib/a.ts',
      '+++ b/lib/a.ts',
      '@@ -3,2 +10,3 @@',
      `-const old = '${key}';`,
      ` const keep = '${key}';`,
      '+const fine = 1;',
      `+const leaked = '${key}';`,
      '',
    ].join('\n');
    expect(scanDiff(diff)).toEqual([{ file: 'lib/a.ts', line: 12, name: 'OpenRouter: ключ API' }]);
  });

  it('строка кода «++i» в диффе («+++i») — содержимое, а не заголовок файла', () => {
    const diff = diffOf('lib/loop.ts', ['++i;', `const k = '${FAKE['GitHub: токен']}';`]);
    const lines = addedLines(diff);
    expect(lines.map((l) => l.file)).toEqual(['lib/loop.ts', 'lib/loop.ts']);
    expect(scanDiff(diff)).toEqual([{ file: 'lib/loop.ts', line: 2, name: 'GitHub: токен' }]);
  });

  it('пометка allow-secret: с причиной снимает находку только на своей строке', () => {
    const key = FAKE['DeepSeek / DashScope: ключ API'];
    const diff = diffOf('tests/fixture.ts', [
      `const k = '${key}'; // allow-secret: фальшивый ключ для проверки опознания`,
      `const k2 = '${key}';`,
    ]);
    expect(scanDiff(diff)).toEqual([{ file: 'tests/fixture.ts', line: 2, name: 'DeepSeek / DashScope: ключ API' }]);
  });

  it('пароль-заглушка в примере строки подключения — не секрет, настоящий — секрет', () => {
    const base = 'postgresql://user:';
    const diff = diffOf('.env.example', [
      `DATABASE_URL=${base}password@localhost:5432/db`,
      `DATABASE_URL=${base}your_password_here@localhost:5432/db`,
      `DATABASE_URL=${base}\${DB_PASSWORD}@localhost:5432/db`,
      `DATABASE_URL=${base}Zq7rT9vK2w@localhost:5432/db`,
      'DATABASE_URL=postgresql://postgres@localhost:55432/postgres',
    ]);
    expect(scanDiff(diff).map((f) => f.line)).toEqual([4]);
  });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

/** git во временном каталоге; цвет и подпись выключены — судится сканер, а не машина. */
function gitIn(dir: string) {
  return (...args: string[]) => execFileSync(
    'git', ['-c', 'color.ui=false', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, env: GIT_ENV, encoding: 'utf8' },
  ).trim();
}

/** Временный git-репозиторий: базовый коммит и коммит с файлами. */
function repoWith(files: Record<string, string>): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  const git = gitIn(dir);
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'база\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'база');
  const base = git('rev-parse', 'HEAD');
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git('add', '-A');
  git('commit', '-q', '-m', 'правка');
  return { dir, base, head: git('rev-parse', 'HEAD') };
}

function runCli(cwd: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, out: String(e.stdout) };
  }
}

describe('сканер как его зовут CI и хук', () => {
  it('ключ в новом коммите — выход 1, аннотация с файлом и строкой, значения нет', () => {
    const key = FAKE['Telegram: токен бота'];
    const { dir, base, head } = repoWith({ 'notes.md': `Проверка\nтокен: ${key}\n` });
    try {
      const r = runCli(dir, ['--range', base, head, '--format=github']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('::error file=notes.md,line=2::');
      expect(r.out).toContain('Telegram: токен бота');
      expect(r.out).not.toContain(key);
      expect(r.out).not.toContain(key.slice(-12));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('без ключей — выход 0', () => {
    const { dir, base, head } = repoWith({ 'lib.ts': 'export const answer = 42;\n' });
    try {
      expect(runCli(dir, ['--range', base, head, '--format=github']).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PR сравнивается от точки ветвления: ключ, убранный в main позже, — не находка ветки', () => {
    // Ключ лежал в main до ветвления; ветка его не трогала; main потом убрал.
    // От головы main («..») строка с ключом выглядит добавленной веткой, от
    // точки ветвления («...») — нет: PR её не приносил.
    const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    const git = gitIn(dir);
    try {
      git('init', '-q');
      writeFileSync(join(dir, 'legacy.ts'), `export const k = '${FAKE['xAI: ключ API']}';\nexport const x = 1;\n`);
      git('add', '-A');
      git('commit', '-q', '-m', 'старое');
      const fork = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'feature');
      writeFileSync(join(dir, 'lib.ts'), 'export const answer = 42;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'ветка');
      const feature = git('rev-parse', 'HEAD');
      git('checkout', '-q', fork);
      writeFileSync(join(dir, 'legacy.ts'), 'export const x = 1;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'main убрал ключ');
      const mainTip = git('rev-parse', 'HEAD');

      expect(runCli(dir, ['--range', mainTip, feature, '--merge-base', '--format=github']).code).toBe(0);
      expect(runCli(dir, ['--range', mainTip, feature, '--format=github']).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('нулевая база пуша — проверяется сам коммит', () => {
    const key = FAKE['AWS / S3: ключ доступа'];
    const { dir, head } = repoWith({ 'deploy.sh': `export AWS_ACCESS_KEY_ID=${key}\n` });
    try {
      const r = runCli(dir, ['--range', '0'.repeat(40), head, '--format=github']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('file=deploy.sh,line=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('битый диапазон — выход 2 и слова «не выполнена», а не «секретов нет»', () => {
    const { dir } = repoWith({ 'lib.ts': 'export const x = 1;\n' });
    try {
      const r = runCli(dir, ['--range', 'deadbeef', 'HEAD', '--format=github']);
      expect(r.code).toBe(2);
      expect(r.out).toContain('не выполнена');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('связка: сканер зовут CI и хук', () => {
  it('workflow проверяет каждый PR и пуш в main без фильтра путей, PR — от точки ветвления', () => {
    const wf = readFileSync(join(process.cwd(), '.github/workflows/secret-scan.yml'), 'utf8');
    expect(wf).toMatch(/pull_request:\s*\n\s*branches: \[main\]/);
    expect(wf).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(wf).not.toMatch(/^\s*paths:/m);
    expect(wf).toMatch(/fetch-depth: 0/);
    expect(wf).toMatch(/node scripts\/security\/secret-scan\.mjs --range "\$PR_BASE" "\$PR_HEAD" --merge-base/);
    expect(wf).toMatch(/node scripts\/security\/secret-scan\.mjs --range "\$PUSH_BEFORE" "\$PUSH_AFTER"/);
  });

  it('хук зовёт тот же сканер, своего списка шаблонов у него нет', () => {
    const hook = readFileSync(join(process.cwd(), '.husky/pre-commit'), 'utf8');
    expect(hook).toMatch(/scripts\/security\/secret-scan\.mjs/);
    expect(hook).toMatch(/--staged/);
    expect(hook).not.toMatch(/sk-or-v1-\[/);
  });
});
