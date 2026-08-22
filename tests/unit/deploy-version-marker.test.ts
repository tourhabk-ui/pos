/**
 * Сторож версионного маркера: сайт обязан уметь назвать свой коммит.
 *
 * 23.08.2026 шаг «Verify deploy reached production» падал на КАЖДОМ деплое с
 * одной строкой: «Сайт отдаёт unknown, и этот коммит не содержит …». Красным
 * был не деплой — красной была неспособность его проверить. Тринадцать
 * прогонов подряд отчитывались отказом, и по ним нельзя было отличить
 * «Timeweb не переключил контейнер» от «мы не умеем спросить».
 *
 * Причина: маркер читал `.git/HEAD` и требовал там голые 40 hex, в расчёте на
 * detached-сборку. Сборка идёт с веткой — в HEAD `ref: refs/heads/main`, — а
 * файла, на который ссылка указывает, в образе не было: `.dockerignore`
 * пускал внутрь только сам HEAD.
 *
 * Тест держит обе половины починки: разыменование ссылки и наличие ссылок в
 * контексте сборки. Без второй первая бесполезна.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { resolveHeadSha } = require_(join(process.cwd(), 'scripts/write-version.js')) as {
  resolveHeadSha: (gitDir?: string) => string | null;
};

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
const DOCKERIGNORE = readFileSync(join(process.cwd(), '.dockerignore'), 'utf8');

describe('версионный маркер: коммит устанавливается по файлам .git', () => {
  it('на этом репозитории sha находится', () => {
    // Работает и при detached HEAD (раннер GitHub), и при HEAD-ссылке
    // (сборка Timeweb) — ровно та разница, на которой всё и сломалось.
    expect(resolveHeadSha()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('HEAD-ссылка разыменовывается через refs/heads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const git = join(dir, '.git');
    mkdirSync(join(git, 'refs', 'heads'), { recursive: true });
    const sha = 'a'.repeat(40);
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(git, 'refs', 'heads', 'main'), `${sha}\n`);
    expect(resolveHeadSha(git)).toBe(sha);
  });

  it('упакованная ветка берётся из packed-refs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const git = join(dir, '.git');
    mkdirSync(git, { recursive: true });
    const sha = 'b'.repeat(40);
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(git, 'packed-refs'), `# pack-refs with: peeled\n${sha} refs/heads/main\n`);
    expect(resolveHeadSha(git)).toBe(sha);
  });

  it('detached HEAD — sha прямо из HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const git = join(dir, '.git');
    mkdirSync(git, { recursive: true });
    const sha = 'c'.repeat(40);
    writeFileSync(join(git, 'HEAD'), `${sha}\n`);
    expect(resolveHeadSha(git)).toBe(sha);
  });

  it('нечего прочитать — null, а не выдуманный sha', () => {
    // «Не знаю» обязано остаться «не знаю»: проверка деплоя должна отличать
    // непроверенность от «не доехало» (§4.0).
    expect(resolveHeadSha(join(mkdtempSync(join(tmpdir(), 'ver-')), 'нет-такого'))).toBeNull();
  });
});

describe('версионный маркер: сборка действительно его пишет', () => {
  it('Dockerfile зовёт скрипт, а не однострочник с наивной проверкой', () => {
    expect(DOCKERFILE).toMatch(/RUN node scripts\/write-version\.js/);
    expect(
      DOCKERFILE,
      'вернулась однострочная версия — она не разыменовывает ссылку',
    ).not.toMatch(/RUN node -e[^\n]*version\.json/);
  });

  it('ссылки .git попадают в контекст сборки', () => {
    // Разыменование бесполезно, если файла ссылки нет в образе. Именно этим
    // и был `unknown`: HEAD пускали, а refs — нет.
    expect(DOCKERIGNORE).toMatch(/^!\.git\/HEAD$/m);
    expect(DOCKERIGNORE).toMatch(/^!\.git\/refs\/\*\*$/m);
    expect(DOCKERIGNORE).toMatch(/^!\.git\/packed-refs$/m);
  });
});
