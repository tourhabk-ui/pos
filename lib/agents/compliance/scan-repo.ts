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
import { scanSource, exportedDoors, defaultDoorImports, moduleKey, type PIIFinding } from './pii-flow-scanner';

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
 * Двери, которые модули отдают под другим именем (семнадцатое ревью PR #3125):
 * `export { callAIFast as ask } from …` в одном файле — и `ask(…)` в другом.
 * Имена собираются по всему репозиторию до неподвижной точки (обёртка над
 * обёрткой), модули с дверью по умолчанию — отдельно: имя у потребителя своё.
 */
export function repoDoorLinks(sources: ReadonlyArray<{ rel: string; src: string }>): { named: string[]; defaultModules: Set<string> } {
  let named: string[] = [];
  const defaultModules = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const next = new Set(named);
    for (const { rel, src } of sources) {
      if (!/\bexport\b/.test(src)) continue;
      const e = exportedDoors(src, named);
      for (const n of e.named) next.add(n);
      if (e.defaultDoor) defaultModules.add(moduleKey(rel));
    }
    if (next.size === named.length) break;
    named = [...next].sort();
  }
  return { named, defaultModules };
}

/** Находки по набору исходников с дверями, пришедшими из других модулей. Чистая — для теста. */
export function scanSources(sources: ReadonlyArray<{ rel: string; src: string }>): PIIFinding[] {
  const { named, defaultModules } = repoDoorLinks(sources);
  const findings: PIIFinding[] = [];
  for (const { rel, src } of sources) {
    const extra = [...named, ...defaultDoorImports(rel, src, defaultModules)];
    for (const f of scanSource(rel, src, extra)) findings.push(f);
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
