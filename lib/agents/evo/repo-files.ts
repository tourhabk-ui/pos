/**
 * Перечень файлов репозитория для эволюции: леджеру покрытия нужен полный список
 * ревьюибельных путей, а мок-детектору — клиент-компоненты. На проде (standalone)
 * .ts/.tsx-исходников на диске нет → фоллбэк на GitHub git/trees API (та же
 * инфраструктура, что уже используется для чтения содержимого файлов).
 *
 * Возвращает repo-relative пути. Кэш в памяти на процесс (дерево меняется редко,
 * а прогон раз в несколько часов).
 */
import { githubFetch } from '@/lib/agents/evo/github-fetch';

const REPO_SLUG = 'tourhabk-ui/pos';
// components/ добавлен по разбору 28.07: четыре партнёрских блока с выдуманными
// ценами и несуществующим трансфером на Курильское озеро жили в
// components/routes/ — то есть ВНЕ обхода. Мок-детектор, заточенный ровно под
// этот класс, смотрел не в ту половину дерева и найти их не мог в принципе.
const WALK_ROOTS = ['app', 'lib', 'components'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);

/**
 * Ниже этого числа локальный обход считается непредставительным.
 *
 * На проде (standalone) исходников на диске нет, и обход обязан вернуть пусто,
 * чтобы сработал фоллбэк на GitHub. Но если в контейнер попала горстка .ts
 * (например через зависимости или частичную копию), обход вернёт «непусто» —
 * источник объявится 'disk', фоллбэк не сработает, и прочёс всей платформы
 * схлопнется до этой горстки. Прогон 28.07 00:09 так и отчитался:
 * files_listed: 10, files_reviewed: 10 — то есть зелёный скан покрывал доли
 * процента репозитория, и по цифре это было неотличимо от здоровья.
 */
const MIN_PLAUSIBLE_LOCAL_FILES = 100;

let cache: { at: number; files: string[] } | null = null;
const CACHE_MS = 30 * 60 * 1000;

/**
 * Откуда взят последний перечень файлов: 'disk' (локальный обход, dev/CI),
 * 'github' (git/trees API — прод-standalone) или 'none' (не достали ниоткуда,
 * прочёс покрытия пуст). Диагностика: на проде 'none' = GitHub недостижим из
 * Timeweb/РФ, и весь sweep коллапсирует в ноль — это видно в ответе скана.
 */
export type RepoFilesSource = 'disk' | 'github' | 'none';
let _lastSource: RepoFilesSource = 'none';
export function getLastListSource(): RepoFilesSource {
  return _lastSource;
}

async function walkLocal(): Promise<string[]> {
  try {
    const [fs, path] = await Promise.all([import('fs'), import('path')]);
    const out: string[] = [];
    const root = process.cwd();
    const walk = (dir: string) => {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full);
        else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
          out.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    for (const r of WALK_ROOTS) walk(path.join(root, r));
    return out;
  } catch {
    return [];
  }
}

async function fetchTree(): Promise<string[]> {
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${REPO_SLUG}/git/trees/main?recursive=1`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kamchatour-evo' }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return [];
    const data = await res.json() as { tree?: Array<{ path: string; type: string }> };
    return (data.tree ?? [])
      .filter((n) => n.type === 'blob' && (n.path.endsWith('.ts') || n.path.endsWith('.tsx')))
      .filter((n) => WALK_ROOTS.some((r) => n.path.startsWith(r + '/')))
      .map((n) => n.path);
  } catch {
    return [];
  }
}

/** Все .ts/.tsx под app/ и lib/ (repo-relative). Локально или из GitHub-дерева. */
export async function listRepoFiles(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.files;
  let files = await walkLocal();
  if (files.length >= MIN_PLAUSIBLE_LOCAL_FILES) {
    _lastSource = 'disk';
  } else {
    // Горстка файлов на диске — не репозиторий, а обрывок: идём в GitHub.
    // Если и он недоступен, честно возвращаем то немногое, что нашли локально,
    // но источником считаем 'none' — прочёс покрытия неполон, и это видно.
    const local = files;
    files = await fetchTree();
    if (files.length > 0) {
      _lastSource = 'github';
    } else {
      files = local;
      _lastSource = 'none';
    }
  }
  if (files.length > 0) cache = { at: Date.now(), files };
  return files;
}

/**
 * Цель мок-детектора: экраны под app/ И переиспользуемые блоки под components/.
 * Прежде фильтр знал только app/ — а витрина-обманка ровно так же живёт в
 * components/ (партнёрские блоки с выдуманным прайсом, разбор 28.07).
 */
export function clientComponentPaths(all: string[]): string[] {
  return all.filter(
    (p) => (p.startsWith('app/') || p.startsWith('components/'))
      && p.endsWith('.tsx')
      && !p.includes('.test.'),
  );
}
