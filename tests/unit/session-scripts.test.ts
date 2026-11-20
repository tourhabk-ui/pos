/**
 * Команды сессии в scripts/session (слово владельца 20.11: «делай а то очень
 * быстро тает лимит»): механические шаги — программой, по строке на шаг,
 * а не вызовами модели с полным выводом в контексте.
 *
 * Проверки — исполнением:
 *  - prepush: план шагов по изменённым файлам (вызов planFor);
 *  - mutate: файл ломается, тест зовётся, файл возвращается — при любом исходе;
 *  - after-merge: настоящий bash на временных git-репозиториях — влитая
 *    ветка перезаписывается от main, невлитая работа — отказ, ветка цела.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planFor } from '@/scripts/session/prepush.mjs';
import { mutateOnce } from '@/scripts/session/mutate.mjs';

const names = (p: ReturnType<typeof planFor>) => p.steps.map((s) => s.name);

describe('prepush: план по изменённым файлам', () => {
  it('код TypeScript — tsc, линтер по файлам, зависимые тесты; тест — сам тест', () => {
    const p = planFor(['lib/safety/mchs-bulletin.ts', 'tests/unit/mchs-row-words.test.ts', 'docs/x.md']);
    expect(names(p)).toEqual(['tsc', 'eslint', 'тесты изменённые', 'тесты зависимые']);
    expect(p.steps.find((s) => s.name === 'eslint')?.cmd).toEqual(['npx', 'eslint', 'lib/safety/mchs-bulletin.ts', 'tests/unit/mchs-row-words.test.ts']);
    expect(p.steps.find((s) => s.name === 'тесты зависимые')?.cmd.slice(-1)).toEqual(['lib/safety/mchs-bulletin.ts']);
  });

  it('только документы — шагов нет; миграция не линтуется', () => {
    expect(planFor(['docs/a.md', 'CLAUDE.md']).steps).toEqual([]);
    expect(names(planFor(['migrations/1471_x.sql'], { existing: [1470] }))).toEqual([]);
  });

  it('тест на базе — шаг при адресе базы, без него — сказано, что не прогнан', () => {
    const pg = 'tests/integration/alert-place-scope.pg.test.ts';
    expect(names(planFor([pg], { hasPg: true }))).toContain('тесты на базе');
    const off = planFor([pg]);
    expect(names(off)).not.toContain('тесты на базе');
    expect(off.notes.join('\n')).toContain(`тесты на базе не прогнаны (нет KERNEL_PG_TEST_URL): ${pg}`);
  });

  it('защищённая зона и занятый номер миграции названы', () => {
    const p = planFor(['middleware.ts', 'migrations/1470_dup.sql'], { existing: [1469, 1470] });
    expect(p.notes.join('\n')).toMatch(/защищённые зоны: middleware\.ts → middleware — в PR нужен раздел «## Слово владельца»/);
    expect(p.notes.join('\n')).toContain('номер 1470 уже есть в базе — перенумеровать (свободный 1471)');
    expect(planFor(['lib/x.ts']).notes).toContain('защищённых зон нет');
  });
});

describe('mutate: сломать, прогнать, вернуть', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mut-'));
    const file = join(dir, 'rule.ts');
    writeFileSync(file, 'export const LIMIT = 10;\n');
    return file;
  };
  /** «Тест»: красный, если в файле нет исходной строки. */
  const check = (file: string) => ['node', '-e', `process.exit(require('fs').readFileSync(${JSON.stringify(file)},'utf8').includes('LIMIT = 10') ? 0 : 1)`];
  const run = (cmd: string[]) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
    return { status: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
  };

  it('тест поймал — RED, файл возвращён', () => {
    const file = setup();
    const res = mutateOnce({ name: 'm', file, old: 'LIMIT = 10', new: 'LIMIT = 11', cmd: check(file) }, run);
    expect(res.verdict).toBe('RED');
    expect(readFileSync(file, 'utf8')).toBe('export const LIMIT = 10;\n');
  });

  it('тест не заметил — GREEN(!); строки нет — NO-MATCH; файл тот же', () => {
    const file = setup();
    const quiet = mutateOnce({ name: 'm', file, old: 'export', new: 'export /* x */', cmd: check(file) }, run);
    expect(quiet.verdict).toBe('GREEN(!)');
    expect(mutateOnce({ name: 'n', file, old: 'нет такой строки', new: 'x', cmd: check(file) }, run).verdict).toBe('NO-MATCH');
    expect(readFileSync(file, 'utf8')).toBe('export const LIMIT = 10;\n');
  });

  it('прогон упал с исключением — файл всё равно возвращён', () => {
    const file = setup();
    expect(() => mutateOnce({ name: 'm', file, old: 'LIMIT = 10', new: 'LIMIT = 0', cmd: ['x'] }, () => { throw new Error('boom'); })).toThrow('boom');
    expect(readFileSync(file, 'utf8')).toBe('export const LIMIT = 10;\n');
  });
});

describe('after-merge: ветка заново от main', () => {
  const SCRIPT = resolve('scripts/session/after-merge.sh');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org',
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'color.ui=false', ...args], { cwd, env, encoding: 'utf8' }).trim();
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', msg);
  };
  /** Сервер с main и веткой сессии `s`, в которой одна правка a.txt. */
  const world = () => {
    const root = mkdtempSync(join(tmpdir(), 'am-'));
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const wc = join(root, 'wc');
    git(root, 'clone', '-q', origin, wc);
    git(wc, 'checkout', '-q', '-b', 'main');
    commit(wc, 'base.txt', 'base\n', 'base');
    git(wc, 'push', '-q', '-u', 'origin', 'main');
    git(wc, 'checkout', '-q', '-b', 's');
    commit(wc, 'a.txt', 'a\n', 'work');
    git(wc, 'push', '-q', '-u', 'origin', 's');
    return wc;
  };
  const squashIntoMain = (wc: string) => {
    git(wc, 'checkout', '-q', 'main');
    commit(wc, 'a.txt', 'a\n', 'squash of s');
    commit(wc, 'other.txt', 'other\n', 'someone else');
    git(wc, 'push', '-q', 'origin', 'main');
  };
  const runScript = (wc: string, branch: string) =>
    spawnSync('bash', [SCRIPT, branch], { cwd: wc, env, encoding: 'utf8' });

  it('ветка влита (squash) — перезаписана от main и запушена', () => {
    const wc = world();
    squashIntoMain(wc);
    const r = runScript(wc, 's');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^OK {4}s = /);
    expect(git(wc, 'ls-remote', 'origin', 'refs/heads/s').split('\t')[0]).toBe(git(wc, 'rev-parse', 'origin/main'));
    expect(git(wc, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('s');
  });

  it('на ветке невлитая правка — отказ, ветка на сервере не тронута', () => {
    const wc = world();
    squashIntoMain(wc);
    git(wc, 'checkout', '-q', 's');
    commit(wc, 'b.txt', 'b\n', 'not merged');
    git(wc, 'push', '-q', 'origin', 's');
    const before = git(wc, 'ls-remote', 'origin', 'refs/heads/s');
    const r = runScript(wc, 's');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ОТКАЗ: на origin\/s .* есть изменения, которых нет в main/);
    expect(git(wc, 'ls-remote', 'origin', 'refs/heads/s')).toBe(before);
  });

  it('ветки на сервере нет — создана от main', () => {
    const wc = world();
    git(wc, 'push', '-q', 'origin', '--delete', 's');
    const r = runScript(wc, 's');
    expect(r.status, r.stderr).toBe(0);
    expect(git(wc, 'ls-remote', 'origin', 'refs/heads/s').split('\t')[0]).toBe(git(wc, 'rev-parse', 'origin/main'));
  });
});
