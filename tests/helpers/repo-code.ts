/**
 * Весь исполняемый код репозитория — для сторожей-запретов («такой записи быть
 * не должно»).
 *
 * Обходится всё, кроме названного в `REPO_CODE_SKIPPED`. Каталог, которого нет
 * в обходе, иначе молча читался бы как «нарушений нет»: перепись писателей
 * таблицы туров смотрела только `app`, `lib` и `scripts`, и запись из
 * `components/`, `integrations/` или корневого `instrumentation.ts` она бы не
 * увидела (ревью безопасности PR #3804, 25.11).
 *
 * Чего обход не видит и что названо: файлы не из списка расширений (`.sql`,
 * `.sh`, `.yml`) и каталоги с точкой (`.git`, `.next`, `.github`, `.claude`).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Каталоги верхнего уровня, которые обход пропускает, — поимённо и с причиной. */
export const REPO_CODE_SKIPPED: Record<string, string> = {
  node_modules: 'чужой код: в этом репозитории его не пишут',
  tests: 'тесты: их запросы идут в тестовую базу или в мок',
  test: 'тесты e2e: то же',
  public: 'статические файлы сайта: исполняет браузер, доступа к базе у них нет',
  coverage: 'отчёт прогона тестов, не код',
  dist: 'результат сборки, не исходник',
};

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(join(root, dir))) {
    // Имя с точки — служебное; node_modules пропускается на любой глубине.
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (dir === '' && name in REPO_CODE_SKIPPED) continue;
    const rel = dir === '' ? name : `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else if (CODE_FILE.test(name)) out.push(rel);
  }
}

/** Пути всех файлов кода от корня репозитория, отсортированные. */
export function repoCodeFiles(root: string = process.cwd()): string[] {
  const out: string[] = [];
  walk(root, '', out);
  return out.sort();
}
