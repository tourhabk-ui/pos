/**
 * Проверки перед коммитом (слово владельца 27.11 «почини проверки перед
 * коммитом», .claude/hooks/commit-gate.mjs).
 *
 * Прежние три хука срабатывали только на команду, начинающуюся с
 * `git commit`, и пропускали `git -c … commit` и `cd … && git commit` —
 * так коммитят сессии. Здесь хук судится двумя способами:
 *  - решение `gate` — на подставных исполнителях: какая проверка запускалась,
 *    что останавливает коммит, что идёт строкой в контекст, и что
 *    «не смог проверить» не равно «чисто» (§4.0);
 *  - сам хук процессом в отдельном git-репозитории: настоящие tsc и аудит
 *    правил на маленьком проекте, событие Claude Code на stdin.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
// @ts-expect-error — хук на чистом JS без деклараций типов
import { gate, isCommit } from '../../.claude/hooks/commit-gate.mjs';

const ROOT = process.cwd();
const HOOK = join(ROOT, '.claude/hooks/commit-gate.mjs');

type Run = { status: number; output: string; reason?: string };
function fakeRun(over: Partial<{ tsc: Run; audit: Run; added: string | null }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    run: {
      tsc: () => (calls.push('tsc'), over.tsc ?? { status: 0, output: '' }),
      audit: (files: string[]) => (calls.push(`audit:${files.join(',')}`), over.audit ?? { status: 0, output: '' }),
      addedLines: () => (calls.push('sql'), over.added === undefined ? '' : over.added),
    },
  };
}

const AUDIT_OUT = [
  'АУДИТ: KamchatourHub [files (1 файлов)]',
  'КРИТИЧНЫЕ (1 нарушений):',
  '  [ ] lib/x.ts:3 — any типы',
  '      const v: any = 1',
  '',
  'ПРЕДУПРЕЖДЕНИЯ (1 нарушений):',
  '  [ ] components/y.tsx:9 — rounded-2xl (→ rounded-lg)',
  'ИТОГО: 2 нарушений',
].join('\n');

describe('коммит узнаётся в той форме, в какой его пишут сессии', () => {
  it.each([
    'git commit -m x',
    'git -c core.hooksPath=/dev/null commit -q -F msg.txt',
    'cd /home/user/pos && git add a.ts && git -c core.hooksPath=/dev/null commit -F m',
    'git -C /repo commit --amend',
  ])('%s', (cmd) => expect(isCommit(cmd)).toBe(true));

  it.each([
    'git status --short',
    'git log --oneline -3',
    'grep "git commit" notes.md',
    'echo коммит через git commit',
    'cat > list.json <<EOF\n[{"name":"коммит только как git commit"}]\nEOF',
  ])('не коммит: %s', (cmd) => expect(isCommit(cmd)).toBe(false));

  it('после переменной окружения и после || — коммит', () => {
    expect(isCommit('GIT_AUTHOR_DATE=now git commit -m x')).toBe(true);
    expect(isCommit('false || git commit -m x')).toBe(true);
  });
});

describe('решение по коммиту', () => {
  it('одни документы — ни tsc, ни аудита', () => {
    const f = fakeRun();
    const r = gate({ files: ['docs/agents/RUSSIA.md', 'README.md'], run: f.run });
    expect(f.calls).toEqual([]);
    expect(r).toMatchObject({ block: null, context: null });
  });

  it('ошибки TypeScript останавливают коммит и называются', () => {
    const f = fakeRun({ tsc: { status: 2, output: 'lib/a.ts(3,7): error TS2322: x\nlib/b.ts(1,1): error TS2304: y' } });
    const r = gate({ files: ['lib/a.ts'], run: f.run });
    expect(r.block).toMatch(/TypeScript: 2 ошиб/);
    expect(r.block).toMatch(/error TS2322/);
  });

  it('tsc не запустился — коммит идёт, но «не проверен», а не «чисто»', () => {
    const f = fakeRun({ tsc: { status: -1, output: '', reason: 'нет node_modules/typescript' } });
    const r = gate({ files: ['scripts/x.mjs'], run: f.run });
    expect(r.block).toBeNull();
    expect(r.context).toMatch(/TypeScript не проверен: нет node_modules\/typescript/);
  });

  it('критичное нарушение аудита останавливает коммит; предупреждения — нет', () => {
    const f = fakeRun({ audit: { status: 1, output: AUDIT_OUT } });
    const r = gate({ files: ['lib/x.ts', 'tests/unit/x.test.ts'], run: f.run });
    expect(f.calls).toContain('audit:lib/x.ts');
    expect(r.block).toMatch(/lib\/x\.ts:3 — any типы/);
    expect(r.block).not.toMatch(/rounded-2xl/);
  });

  it('упавший аудит (код 1 без нарушений) не выдаётся за нарушение и не за «чисто»', () => {
    const f = fakeRun({ audit: { status: 1, output: 'Error: Cannot find module' } });
    const r = gate({ files: ['lib/x.ts'], run: f.run });
    expect(r.block).toBeNull();
    expect(r.context).toMatch(/Аудит правил не выполнен/);
  });

  it('аудит смотрит только app/, lib/, components/', () => {
    const f = fakeRun();
    gate({ files: ['tests/unit/a.test.ts', 'scripts/b.mjs'], run: f.run });
    expect(f.calls.some((c) => c.startsWith('audit'))).toBe(false);
    expect(f.calls).toContain('tsc');
  });

  it('новый SQL — строка для модели; import … from — не SQL', () => {
    const sql = gate({ files: ['lib/q.ts'], run: fakeRun({ added: "+  await pool.query('SELECT id FROM places')" }).run });
    expect(sql.block).toBeNull();
    expect(sql.context).toMatch(/новые SQL-запросы.*pg-verify/);
    const imp = gate({ files: ['lib/q.ts'], run: fakeRun({ added: "+import { pool } from '@/lib/db-pool'" }).run });
    expect(imp.context).toBeNull();
  });

  it('изменения не прочитались — так и сказано', () => {
    const r = gate({ files: ['lib/q.ts'], run: fakeRun({ added: null }).run });
    expect(r.context).toMatch(/SQL-запросы не проверены/);
  });
});

describe('хук процессом в отдельном репозитории', () => {
  let repo = '';
  const git = (...args: string[]) => execFileSync('git', ['-c', 'color.ui=false', ...args], { cwd: repo, encoding: 'utf8' });
  const hook = (input: Record<string, unknown>) => {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', ...input }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      encoding: 'utf8',
    });
    const out = r.stdout.trim();
    return {
      status: r.status,
      stderr: r.stderr,
      context: out ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : null,
    };
  };
  const commit = () => hook({ tool_name: 'Bash', tool_input: { command: `cd ${repo} && git -c core.hooksPath=/dev/null commit -q -F m` } });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'commit-gate-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, '.claude/skills/kamchatka/scripts'), { recursive: true });
    copyFileSync(join(ROOT, '.claude/skills/kamchatka/scripts/audit.mjs'), join(repo, '.claude/skills/kamchatka/scripts/audit.mjs'));
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: ['lib'] }),
    );
    mkdirSync(join(repo, 'lib'));
    writeFileSync(join(repo, 'lib/ok.ts'), 'export const ok = 1;\n');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });

  beforeEach(() => {
    git('checkout', '-q', '.');
    git('clean', '-fdq');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('не коммит — молчание', () => {
    writeFileSync(join(repo, 'lib/bad.ts'), "export const n: number = 'x';\n");
    expect(hook({ tool_name: 'Bash', tool_input: { command: 'git status' } })).toMatchObject({ status: 0, context: null, stderr: '' });
  });

  it('коммит одних документов идёт без проверок', () => {
    writeFileSync(join(repo, 'README.md'), 'y\n');
    expect(commit()).toMatchObject({ status: 0, context: null });
  });

  it('ошибка TypeScript в незастейдженном файле останавливает `git -c … commit` после cd', () => {
    writeFileSync(join(repo, 'lib/bad.ts'), "export const n: number = 'x';\n");
    const r = commit();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Коммит остановлен/);
    expect(r.stderr).toMatch(/TypeScript: 1 ошиб/);
    expect(r.stderr).toMatch(/TS2322/);
  }, 60_000);

  it('критичное нарушение правил останавливает коммит', () => {
    writeFileSync(join(repo, 'lib/any.ts'), 'export const v: any = 1;\n');
    const r = commit();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Аудит правил CLAUDE\.md/);
    expect(r.stderr).toMatch(/lib\/any\.ts:1/);
  }, 60_000);

  it('чистый код с новым SQL — коммит идёт, модели строка про pg-verify', () => {
    writeFileSync(join(repo, 'lib/q.ts'), "export const q = 'SELECT id FROM places WHERE id = $1';\n");
    const r = commit();
    expect(r.status).toBe(0);
    expect(r.context).toMatch(/pg-verify/);
  }, 60_000);
});

describe('подключение', () => {
  it('хук стоит на Bash в .claude/settings.json, старых проверок с `git commit*` нет', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')) as {
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string; if?: string }[] }[] };
    };
    const bash = settings.hooks.PreToolUse.filter((e) => new RegExp(`^(?:${e.matcher ?? ''})$`).test('Bash')).flatMap((e) => e.hooks);
    expect(bash.some((h) => h.command.includes('.claude/hooks/commit-gate.mjs'))).toBe(true);
    // Фильтр `Bash(git commit*)` не видит `git -c … commit`: из-за него прежние проверки молчали.
    expect(bash.filter((h) => h.if && /git commit/.test(h.if))).toEqual([]);
  });
});
