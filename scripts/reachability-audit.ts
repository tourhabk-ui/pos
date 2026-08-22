/**
 * scripts/reachability-audit.ts — перепись достижимости.
 *
 * Перепись экспортов (`scripts/export-census.ts`) считает функции. Она не видит
 * трёх других поверхностей, у каждой свой способ быть мёртвой:
 *
 *   страница   — файл есть, маршрут отдаётся, но из интерфейса на него не
 *                ведёт ни одна ссылка;
 *   API-роут   — эндпоинт есть, но его никто не зовёт: ни код, ни workflow;
 *   компонент  — файл есть, но его никто не импортирует.
 *
 * Инструмент СЧИТАЕТ, а не судит. Ненайденная ссылка — это «не нашёл», а не
 * «мёртвое»: у части поверхностей вход законно снаружи репозитория —
 * поисковик по sitemap, вебхук платёжной системы, токен-ссылка в мессенджере,
 * внешний планировщик (cron-job.org), адрес, набранный админом руками.
 * Поэтому вывод разделён на «упоминается ГДЕ-ТО» и «НИГДЕ», и решение по
 * каждой строке принимает человек.
 *
 * Известные пределы измерения:
 *   - путь, собранный из переменной в СЕРЕДИНЕ (`/api/${section}/list`), не
 *     находится; динамический сегмент `[id]` — находится (сверка по префиксу);
 *   - внешние планировщики и внешние вызывающие в репозитории не видны;
 *   - строка в комментарии считается упоминанием (нарочно: комментарий
 *     показывает, что о поверхности хотя бы помнят).
 *
 * Запуск: npx tsx scripts/reachability-audit.ts [pages|api|components]
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'coverage']);
// .py/.sh — тоже: адрес схемного слепка строится в scripts/assemble-db-baseline.py.
const EXT = ['.ts', '.tsx', '.js', '.mjs', '.json', '.yml', '.yaml', '.html', '.py', '.sh'];
const DIRS = ['app', 'components', 'lib', 'hooks', 'public', 'scripts', 'tests', '.github', 'infra'];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const src = new Map<string, string>();
for (const f of DIRS.flatMap(d => walk(path.join(ROOT, d)))
  .concat(fs.readdirSync(ROOT).filter(f => EXT.includes(path.extname(f))).map(f => path.join(ROOT, f)))) {
  const rel = path.relative(ROOT, f);
  // Себя не считаем: примеры путей в этих комментариях — не входы.
  if (rel === 'scripts/reachability-audit.ts') continue;
  src.set(rel, fs.readFileSync(f, 'utf8'));
}

/** Путь до первого динамического сегмента: /api/places/[id]/reviews → /api/places. */
function prefixOf(route: string): string {
  const i = route.indexOf('/[');
  return i === -1 ? route : route.slice(0, i);
}

/**
 * Кто упоминает путь. Условие только на КОНЕЦ пути: адрес пишут и как
 * '/api/x', и как "$APP_URL/api/x" в workflow — требование кавычки слева
 * теряло вторые (45 cron-роутов ложно числились незапланированными).
 */
/**
 * Встречается ли в строке ссылка ИМЕННО на этот путь.
 *
 * Справа — конец пути (иначе '/api/tours' поймает '/api/tours-feed').
 * Слева — либо не-путевой символ, либо путь стоит внутри адреса: в workflow
 * пишут "https://vedarai.ru/api/cron/x" и "$APP_URL/api/cron/x", там слева
 * буква. Без учёта адресов 45 запланированных cron числились мёртвыми; без
 * левой границы '/cart' находился внутри '/hub/tourist/cart'.
 */
function hasPathRef(line: string, pref: string): boolean {
  for (let i = line.indexOf(pref); i !== -1; i = line.indexOf(pref, i + 1)) {
    const after = line[i + pref.length] ?? '';
    if (after && !`"'\`/?#,) `.includes(after)) continue;
    const before = line[i - 1] ?? '';
    if (!/[a-z0-9_-]/.test(before)) return true;         // кавычка, пробел, скобка, }
    const head = line.slice(0, i);
    if (head.includes('://') || /\$\{?[A-Za-z_]*$/.test(head)) return true;  // адрес или переменная
  }
  return false;
}

function mentions(route: string, ownFile: string): { ui: string[]; other: string[] } {
  const pref = prefixOf(route);
  const dir = path.dirname(ownFile);
  const ui: string[] = [], other: string[] = [];
  for (const [f, body] of src) {
    if (f === ownFile || f.startsWith(dir + '/')) continue;
    if (!body.includes(pref)) continue;
    if (!body.split('\n').some(l => hasPathRef(l, pref))) continue;
    // Ссылка из интерфейса = переход руками. Остальное — вебхук, cron, тест.
    const isUi = (f.startsWith('app/') || f.startsWith('components/') || f.startsWith('hooks/'))
      && !f.includes('/api/') && !f.startsWith('tests/');
    (isUi ? ui : other).push(f);
  }
  return { ui, other };
}

function report(title: string, rows: Array<{ id: string; where: string[] }>, total: number) {
  console.log(`\n${title}: всего ${total}, без входа из кода ${rows.length}`);
  for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${r.id}${r.where.length ? `   ← ${r.where.slice(0, 3).join(', ')}` : '   ← НИГДЕ'}`);
  }
}

// ── Страницы ────────────────────────────────────────────────────────────────
// Входы, до которых доходят не по ссылке: корень, офлайн-фолбэк SW, аварийная.
const ENTRYPOINTS = new Set(['/', '/offline', '/emergency']);

function pages() {
  const all = [...src.keys()].flatMap(f => {
    if (f === 'app/page.tsx') return [{ file: f, route: '/' }];
    const m = /^app\/(.*)\/page\.tsx$/.exec(f);
    if (!m) return [];
    const segs = m[1].split('/').filter(s => !(s.startsWith('(') && s.endsWith(')')));
    return [{ file: f, route: '/' + segs.join('/') }];
  });
  const rows = all
    .filter(p => !ENTRYPOINTS.has(p.route))
    .map(p => ({ p, m: mentions(p.route, p.file) }))
    .filter(x => x.m.ui.length === 0)
    .map(x => ({ id: x.p.route, where: x.m.other }));
  report('СТРАНИЦЫ без ссылки из интерфейса', rows, all.length);
}

// ── API ─────────────────────────────────────────────────────────────────────
function api() {
  const all = [...src.keys()].flatMap(f => {
    const m = /^app\/(api\/.*)\/route\.tsx?$/.exec(f);
    if (!m) return [];
    const segs = m[1].split('/').filter(s => !(s.startsWith('(') && s.endsWith(')')));
    return [{ file: f, route: '/' + segs.join('/') }];
  });
  const rows = all
    .map(r => ({ r, m: mentions(r.route, r.file) }))
    .filter(x => x.m.ui.length === 0 && x.m.other.every(f => f.startsWith('tests/')))
    .map(x => ({ id: x.r.route, where: x.m.other }));
  report('API-РОУТЫ, которых не зовёт рабочий код', rows, all.length);
}

// ── Компоненты ──────────────────────────────────────────────────────────────
function components() {
  const all = [...src.keys()].filter(f => f.startsWith('components/') && f.endsWith('.tsx'));
  const rows: Array<{ id: string; where: string[] }> = [];
  for (const c of all) {
    const base = path.basename(c, '.tsx');
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // И статический `from '...'`, и ленивый `dynamic(() => import('...'))`.
    // Без второго 19 живых компонентов карточки точки числились мёртвыми:
    // _PlaceDetailClient грузит их все через next/dynamic.
    const re = new RegExp(`(from|import\\()\\s*['"][^'"]*/${esc}['"]`);
    const where: string[] = [];
    let prod = false;
    for (const [f, body] of src) {
      if (f === c || !body.includes(base)) continue;
      if (!re.test(body)) continue;
      where.push(f);
      if (!f.startsWith('tests/')) prod = true;
    }
    if (!prod) rows.push({ id: c, where });
  }
  report('КОМПОНЕНТЫ, которых никто не импортирует', rows, all.length);
}

const which = process.argv[2];
if (!which || which === 'pages') pages();
if (!which || which === 'api') api();
if (!which || which === 'components') components();
