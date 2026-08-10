/**
 * Исходник не может быть невидим для git.
 *
 * 10.08 в .gitignore сработал шаблон `*-copy.*`, задуманный для черновиков
 * вроде `route-copy.ts`. Он съел новый модуль `lib/services/safety/push-copy.ts`
 * и его тест: `git add -A` их не добавил, `git status` промолчал, коммит ушёл
 * без них — а крон уже импортировал несуществующий файл.
 *
 * Поймалось случайно: по счётчику файлов в README, и только потому, что тот
 * гард к этому моменту научился называть расхождение, а не просто краснеть.
 * Своими силами эта потеря не обнаруживалась вовсе — ни одной ошибки, ни
 * одного предупреждения, пустое место там, где должен быть файл.
 *
 * Тот же `*backup*` рядом съел бы `lib/backup-service.ts`. Поэтому проверка
 * не про одно имя, а про правило: под исходными каталогами не должно быть ни
 * одного игнорируемого файла с расширением исходника.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/** Каталоги, где лежит код платформы. Черновикам здесь не место. */
const SOURCE_DIRS = ['app', 'lib', 'components', 'hooks', 'tests', 'scripts'];
const SOURCE_EXT = /\.(ts|tsx|mjs)$/;

/**
 * Файлы, которые git считает игнорируемыми, под исходными каталогами.
 *
 * `--others --ignored --exclude-standard` перечисляет именно то, что скрыто
 * правилами игнорирования, а не то, что просто не добавлено.
 */
function ignoredUnderSourceDirs(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...SOURCE_DIRS],
    { encoding: 'utf-8', cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('шаблоны игнорирования не съедают исходники', () => {
  it('под каталогами кода нет игнорируемых .ts/.tsx/.mjs', () => {
    const swallowed = ignoredUnderSourceDirs().filter((p) => SOURCE_EXT.test(p));
    // Сообщение важнее самой проверки: молча потерянный файл нельзя найти
    // иначе, чем по имени.
    expect(swallowed, `git игнорирует исходники:\n${swallowed.join('\n')}`).toEqual([]);
  });

  it('сама проверка работает — git отвечает и список вообще собирается', () => {
    // Если бы execFileSync падал, предыдущий тест был бы зелёным по причине
    // «пустой список» и стерёг бы пустоту.
    expect(() => ignoredUnderSourceDirs()).not.toThrow();
  });
});
