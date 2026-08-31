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
 * 29.08.2026: та же жалоба вернулась спустя шесть дней после фикса выше — и
 * этот сторож её НЕ поймал, потому что проверял лишь текстовое наличие
 * `!`-строк. Строки были на месте; ломало их родительское исключение `.git`
 * (без звёздочки) ВЫШЕ по файлу — Docker после такой строки в директорию не
 * заходит вовсе, и переисключения ниже не значат ничего (документированное
 * ограничение .dockerignore). Тест ниже теперь запрещает саму форму,
 * которая это ломает, а не только присутствие лечения.
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
const { resolveHeadSha, resolveHeadShaDetailed } = require_(join(process.cwd(), 'scripts/write-version.js')) as {
  resolveHeadSha: (gitDir?: string) => string | null;
  resolveHeadShaDetailed: (gitDir?: string) => { sha: string | null; reason: string };
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

/**
 * 30.08: `unknown` вернулся ТРЕТИЙ раз — после починок 23.08 (разыменование
 * ссылки) и 29.08 (форма `.git/*`). Обе прежние причины закрыты и держатся
 * сторожами выше, значит причина новая. Назвать её было нечем: на три
 * независимых исхода приходилось одно слово в логе.
 *
 * Это тот же дефект, что чинится в проверке деплоя, только на шаг раньше:
 * «не знаю» без причины бесполезно ровно так же, как «не знаю», выданное
 * за «не доехало».
 */
describe('версионный маркер: «не знаю» называет свою причину', () => {
  const mkGit = (files: Record<string, string>) => {
    const git = join(mkdtempSync(join(tmpdir(), 'ver-')), '.git');
    mkdirSync(git, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const full = join(git, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
    return git;
  };

  it('успех несёт reason=ok — поле есть всегда, а не только при беде', () => {
    // Иначе отсутствие поля значило бы сразу две вещи: «причина не нужна» и
    // «маркер старой сборки». Их надо различать.
    expect(resolveHeadShaDetailed()).toMatchObject({ reason: 'ok' });
    expect(resolveHeadShaDetailed().sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('.git не доехал вовсе — no_git_head', () => {
    // Гипотеза о сборке Timeweb: контекст без .git. Чинится контекстом
    // сборки, а не .dockerignore — и это разные работы.
    const res = resolveHeadShaDetailed(join(mkdtempSync(join(tmpdir(), 'ver-')), 'нет-такого'));
    expect(res).toEqual({ sha: null, reason: 'no_git_head' });
  });

  it('.git доехал, ссылок нет — ref_and_packed_missing', () => {
    // Это ровно регрессия 23.08 (HEAD пускали, refs — нет). Отдельное имя,
    // потому что чинится .dockerignore, а не контекстом.
    const git = mkGit({ HEAD: 'ref: refs/heads/main\n' });
    expect(resolveHeadShaDetailed(git)).toEqual({ sha: null, reason: 'ref_and_packed_missing' });
  });

  it('packed-refs есть, нашей ветки в нём нет — ref_not_in_packed', () => {
    const git = mkGit({
      HEAD: 'ref: refs/heads/main\n',
      'packed-refs': `# pack-refs with: peeled\n${'a'.repeat(40)} refs/heads/other\n`,
    });
    expect(resolveHeadShaDetailed(git)).toEqual({ sha: null, reason: 'ref_not_in_packed' });
  });

  it('HEAD не опознан — head_unrecognized', () => {
    const git = mkGit({ HEAD: 'не ссылка и не sha\n' });
    expect(resolveHeadShaDetailed(git)).toEqual({ sha: null, reason: 'head_unrecognized' });
  });

  it('старая обёртка не сломана: sha или null, как и раньше', () => {
    // resolveHeadSha остаётся ради вызывающих, которым причина не нужна.
    expect(resolveHeadSha()).toBe(resolveHeadShaDetailed().sha);
  });

  it('причина уходит и в лог сборки, и в сам version.json', () => {
    // В логе — чтобы читалась при разборе сборки; в файле — чтобы проверка
    // деплоя называла причину прямо в прогоне, не читая чужой лог Timeweb.
    const SRC = readFileSync(join(process.cwd(), 'scripts/write-version.js'), 'utf8');
    expect(SRC).toMatch(/console\.log\(`\[version\] commit=\$\{[^}]+\} reason=\$\{reason\}`\)/);
    const marker = SRC.slice(SRC.indexOf("'public/version.json'"), SRC.indexOf('console.log'));
    expect(marker, 'reason обязан попасть в сам файл маркера').toMatch(/\breason,/);
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

  it('29.08: родительское исключение не глушит переисключения .git ниже', () => {
    // Целевой сторож ровно на регрессию 29.08, не общий движок семантики
    // .dockerignore (та живёт в Docker, повторять её статикой — see 42P08 в
    // CLAUDE.md §4.0: судить статикой чужой рантайм запрещено). Проверено
    // РЕАЛЬНОЙ сборкой (docker build + export) при внесении фикса — здесь
    // только защита от повторного заведения того же паттерна.
    //
    // Строка `.git` (голая, без `/*`) исключает саму директорию — Docker
    // после такой строки внутрь не заходит, и любые `!.git/...` ниже не
    // действуют (документированное ограничение). Рабочая форма — `.git/*`:
    // она исключает СОДЕРЖИМОЕ, а не саму директорию, и переисключения ниже
    // остаются в силе.
    const lines = DOCKERIGNORE.split('\n');
    const bareGitIndex = lines.findIndex((l) => l.trim() === '.git');
    const firstNegationIndex = lines.findIndex((l) => l.trim().startsWith('!.git/'));

    expect(
      bareGitIndex,
      'голая строка `.git` в .dockerignore блокирует все !.git/* ниже неё',
    ).toBe(-1);
    expect(firstNegationIndex, 'переисключения .git/* должны присутствовать').toBeGreaterThan(-1);
    expect(DOCKERIGNORE).toMatch(/^\.git\/\*$/m);
  });
});
