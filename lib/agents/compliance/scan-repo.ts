/**
 * ФС-обёртка над `pii-flow-scanner`: обходит исходники и собирает находки.
 * Вынесено из ядра, чтобы `scanSource` оставался чистым и тестируемым без ФС.
 *
 * `ALLOWLIST` — реестр отревьюенных исключений (файл + причина). Находка в
 * allowlisted-файле не считается нарушением, но остаётся видимой. Добавлять
 * запись сюда = сознательное решение «здесь ПД в промпте оправдано/безопасно».
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { scanSource, exportedDoors, importedDoors, reExportedDoors, moduleKey, type DoorArgs, type ModuleDoors, type PIIFinding } from './pii-flow-scanner';

/** Корни, где живёт код с промптами. */
export const SCAN_ROOTS = ['lib', 'app'] as const;

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__', 'tests']);

/**
 * Отревьюенные исключения. Пусто = «ни один промпт не должен слать сырые ПД».
 * Формат: repo-relative путь → причина. Точное совпадение по файлу.
 */
export const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [];

function walk(dir: string, root: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, root, acc);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      if (name.endsWith('.test.ts') || name.endsWith('.test.tsx') || name.endsWith('.d.ts')) continue;
      acc.push(full);
    }
  }
}

/** Исходники корней сканирования: путь от корня репозитория и текст. */
function readSources(repoRoot: string): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const r of SCAN_ROOTS) {
    const files: string[] = [];
    walk(join(repoRoot, r), repoRoot, files);
    for (const abs of files) {
      let src: string;
      try {
        src = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      out.push({ rel: relative(repoRoot, abs).split('\\').join('/'), src });
    }
  }
  return out;
}

/**
 * Двери, которые модули отдают наружу под своим именем экспорта (семнадцатое
 * и восемнадцатое ревью): псевдоним (`export { callAIFast as ask } from …`),
 * функция-обёртка (`export const ask = (p) => callAIFast(p)`), экспорт по
 * умолчанию и переэкспорт из другого модуля (`export { default as ask } from
 * './relay'`, `export * from …`). Граф импортов проходится до неподвижной
 * точки: обёртка над обёрткой через любое число файлов. Имя доходит только до
 * файла, который его импортирует, — общая для репозитория «дверь `ask`»
 * сделала бы стоком любой чужой `ask(…)`.
 */
export function repoDoorLinks(sources: ReadonlyArray<{ rel: string; src: string }>): ModuleDoors {
  const modules = new Map<string, Map<string, DoorArgs>>();
  const exporting = sources.filter((s) => /\bexport\b/.test(s.src));
  // Файл пересчитывается, только когда изменились пришедшие в него двери:
  // разбор экспорта — самая дорогая часть, и второй круг повторял бы первый.
  const seen = new Map<string, string>();
  for (let round = 0; round < 12; round++) {
    let grew = false;
    for (const { rel, src } of exporting) {
      const incoming = importedDoors(rel, src, modules);
      const sig = JSON.stringify([...incoming]) + JSON.stringify([...reExportedDoors(rel, src, modules)]);
      if (seen.get(rel) === sig) continue;
      seen.set(rel, sig);
      const e = exportedDoors(src, incoming);
      const found = new Map<string, DoorArgs>([...e.named, ...reExportedDoors(rel, src, modules)]);
      if (e.defaultDoor !== undefined) found.set('default', e.defaultDoor);
      if (found.size === 0) continue;
      const key = moduleKey(rel);
      const set = modules.get(key) ?? new Map<string, DoorArgs>();
      for (const [n, a] of found) if (!set.has(n)) { set.set(n, a); grew = true; }
      modules.set(key, set);
    }
    if (!grew) break;
  }
  return modules;
}

/** Находки по набору исходников с дверями, пришедшими импортом из других модулей. Чистая — для теста. */
export function scanSources(sources: ReadonlyArray<{ rel: string; src: string }>): PIIFinding[] {
  const modules = repoDoorLinks(sources);
  const findings: PIIFinding[] = [];
  for (const { rel, src } of sources) {
    for (const f of scanSource(rel, src, importedDoors(rel, src, modules))) findings.push(f);
  }
  return findings;
}

/** Все находки по репозиторию (без учёта allowlist). `repoRoot` — абсолютный корень. */
export function scanRepo(repoRoot: string): PIIFinding[] {
  return scanSources(readSources(repoRoot));
}

/** Находки, не покрытые allowlist — это НАРУШЕНИЯ (блокируют CI). */
export function findViolations(repoRoot: string): PIIFinding[] {
  const allow = new Set(ALLOWLIST.map((a) => a.file));
  return scanRepo(repoRoot).filter((f) => !allow.has(f.file));
}
