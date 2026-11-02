/**
 * Сторож путей Scout-Innovator: issue заводится только против РЕАЛЬНОГО кода.
 *
 * Повод (31.10, issues #2898/#2902/#2904): агент ссылался на /api/map/pack,
 * /api/offline/pack, schema-usage.ts, /api/admin/stats — ничего из этого в
 * репозитории нет. Причина двойная: (1) на проде образ standalone, исходников
 * app/ и lib/ нет, сканер возвращал пусто, и модель не видела структуру;
 * (2) выдачу модели никто не сверял с деревом файлов.
 *
 * Теперь список файлов берётся из repo-manifest.json (пишется при сборке,
 * scripts/write-repo-manifest.js), а каждое предложение проверяется кодом:
 * несуществующий файл заменяется единственным реальным кандидатом с тем же
 * именем или предложение пропускается; упомянутый несуществующий /api/...
 * роут — всегда пропуск.
 */
import { readFile, readdir } from 'fs/promises';
import { join, relative } from 'path';

export interface ProposalPaths {
  title: string;
  why: string;
  files_to_change: string[];
  implementation_steps: string[];
  acceptance_criteria: string[];
}

const SCAN_DIRS = ['app', 'lib', 'components', 'migrations', 'scripts', 'hooks'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);
const FILE_RE = /\.(tsx?|jsx?|mjs|sql)$/;

/** Реальные файлы репо: манифест сборки, иначе обход ФС. null — узнать не смогли. */
export async function loadRepoFiles(root: string = process.cwd()): Promise<string[] | null> {
  try {
    const raw = await readFile(join(root, 'repo-manifest.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { files?: unknown };
    if (Array.isArray(parsed.files)) {
      const files = parsed.files.filter((f): f is string => typeof f === 'string');
      if (files.length > 0) return files;
    }
  } catch {
    /* манифеста нет (dev, раннер) — идём обходом ФС ниже */
  }
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (FILE_RE.test(e.name)) files.push(relative(root, full).split('\\').join('/'));
    }
  }
  for (const d of SCAN_DIRS) await walk(join(root, d));
  return files.length > 0 ? files.sort() : null;
}

/** app/api/x/[id]/route.ts → /api/x/[id] */
export function apiRoutesFromFiles(files: string[]): string[] {
  return files
    .filter((f) => /^app\/api\/.*route\.(ts|js)$/.test(f))
    .map((f) => '/' + f.replace(/^app\//, '').replace(/\/route\.(ts|js)$/, ''))
    .map((r) => r.replace(/\/\([^/]+\)/g, ''))
    .sort();
}

/** Все упоминания /api/... в тексте. */
export function extractApiEndpoints(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/api\/[A-Za-z0-9_\-/[\]:.{}]*/g)) {
    const ep = m[0].replace(/[.:/]+$/, '');
    if (ep.length > '/api'.length) out.add(ep);
  }
  return [...out];
}

function isDynamic(seg: string): boolean {
  return /^\[.+\]$/.test(seg) || /^:.+/.test(seg) || /^\{.+\}$/.test(seg);
}

/** Есть ли роут под упомянутый эндпоинт (с учётом [param] и [...slug]). */
export function endpointExists(endpoint: string, routes: string[]): boolean {
  const want = endpoint.split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean);
  return routes.some((r) => {
    const have = r.split('/').filter(Boolean);
    for (let i = 0; i < have.length; i++) {
      const h = have[i];
      if (/^\[\[?\.\.\./.test(h)) return i < want.length || h.startsWith('[[');
      const w = want[i];
      if (w === undefined) return false;
      if (h === w) continue;
      if (isDynamic(h) || isDynamic(w)) continue;
      return false;
    }
    return have.length === want.length;
  });
}

/** «lib/x.ts (новый)» → «lib/x.ts» */
export function normalizePath(p: string): string {
  return p.trim().replace(/^`|`$/g, '').replace(/\s*\(.*\)\s*$/, '').replace(/^\.?\//, '').trim();
}

export type PathCheck<P extends ProposalPaths> =
  | { kind: 'ok'; proposal: P; rewritten: string[] }
  | { kind: 'skip'; reason: string };

/**
 * Сверка предложения с реальным деревом. Несуществующий файл заменяется
 * ЕДИНСТВЕННЫМ реальным файлом с тем же именем; нет такого (или их несколько)
 * — пропуск. Любой упомянутый несуществующий /api/... — пропуск: текст задачи
 * переписать честно нельзя.
 */
export function validateProposalPaths<P extends ProposalPaths>(p: P, repoFiles: string[]): PathCheck<P> {
  const fileSet = new Set(repoFiles);
  const routes = apiRoutesFromFiles(repoFiles);
  const files: string[] = [];
  const rewritten: string[] = [];
  for (const raw of p.files_to_change ?? []) {
    const f = normalizePath(raw);
    if (!f) continue;
    if (fileSet.has(f)) { files.push(f); continue; }
    const base = f.split('/').pop() ?? '';
    const candidates = base && !/^(route|page|layout|index)\.(tsx?|js)$/.test(base)
      ? repoFiles.filter((r) => r.endsWith('/' + base))
      : [];
    if (candidates.length === 1) {
      files.push(candidates[0]);
      rewritten.push(`${f} → ${candidates[0]}`);
      continue;
    }
    return { kind: 'skip', reason: `файла нет в репозитории: ${f}` };
  }
  if (files.length === 0) return { kind: 'skip', reason: 'нет ни одного реального файла для изменения' };

  const text = [p.title, p.why, ...files, ...(p.implementation_steps ?? []), ...(p.acceptance_criteria ?? [])].join('\n');
  for (const ep of extractApiEndpoints(text)) {
    if (!endpointExists(ep, routes)) return { kind: 'skip', reason: `эндпоинта нет в репозитории: ${ep}` };
  }
  return { kind: 'ok', proposal: { ...p, files_to_change: [...new Set(files)] }, rewritten };
}

/** Список реальных файлов для промпта: lib/ и роуты API, с потолком длины. */
export function realFileListForPrompt(repoFiles: string[], maxChars = 45000): string {
  const relevant = repoFiles.filter((f) => /^lib\/.*\.tsx?$/.test(f) || /^app\/api\/.*route\.ts$/.test(f));
  const out: string[] = [];
  let len = 0;
  for (const f of relevant) {
    if (len + f.length + 1 > maxChars) break;
    out.push(f);
    len += f.length + 1;
  }
  return out.join('\n');
}
