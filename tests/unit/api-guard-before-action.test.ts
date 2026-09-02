/**
 * Сторож периметра: у каждого роута под /api/admin и /api/cron проверка
 * доступа стоит раньше действия и делается общим хелпером, а не руками.
 *
 * ── Почему это сторож в CI, а не объектив эволюции ───────────────────────
 *
 * На Edge оба каталога открыты анониму: `/api/admin` и `/api/cron` стоят в
 * PUBLIC_API_ROUTES с пометкой «проверка внутри». Значит единственная дверь —
 * сам хендлер, и таких хендлеров больше трёхсот. Дисциплина на триста файлов
 * без сторожа держится на памяти; объектив Growth Scan (`static-checks`)
 * забытый хелпер видит, но мерж не блокирует. Аудит 01.09 назвал это главным
 * риском периметра и был прав: карта ролей `'/api/admin': 'admin'` в
 * middleware недостижима — аноним уходит на публичном пропуске раньше, чем
 * до неё доходит очередь.
 *
 * Перепись 01.09 перед сторожем: 155 admin-роутов, 164 cron-роута, ни одного
 * без проверки и ни одного, где действие стояло бы раньше проверки. Зато
 * ПЯТЬ сравнивали секрет руками — `!==` вместо постоянного времени, один
 * читал его из `?secret=`. Все пять переведены на `verifyCronSecret` тем же
 * PR, и правило ниже держит достигнутое, а не описывает желаемое.
 *
 * ── Правило, три части, на коде без комментариев ─────────────────────────
 *
 *   1. в хендлере есть признанная проверка: `requireAdmin`, `verifyCronSecret`
 *      либо `getCronSecret` + `timingSafeCompare`; допускается вызов локальной
 *      функции файла, внутри которой стоит одна из них;
 *   2. первая проверка стоит РАНЬШЕ первого действия — запроса к БД, вызова
 *      AI, внешнего `fetch`;
 *   3. секрет не сравнивается `===`/`!==` и не читается из query в роуте —
 *      разбор и сравнение живут только в `lib/auth/cron.ts`.
 *
 * Исключения — по имени и с причиной; список может только сокращаться, и
 * запись, у которой проверка появилась, красит прогон: она больше не
 * исключение.
 *
 * ── Оговорка §4.0 ────────────────────────────────────────────────────────
 *
 * Сторож статический. «Раньше действия» он судит по позиции в тексте
 * хендлера, не по исполнению: проверка под условием или в ветке, куда поток
 * не заходит, ему не видна. Он закрывает «забыли хелпер», «сравнили руками» и
 * «сначала запрос, потом проверка» — не всё множество ошибок доступа.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();

/** Роуты, где признанной проверки нет намеренно. Путь → причина. */
export const GUARD_EXCEPTIONS: Record<string, string> = {
  'app/api/admin/auth/issue-token/route.ts':
    'выдаёт admin-JWT по ADMIN_TOKEN_SECRET; сравнение через crypto.timingSafeEqual, ' +
    'хелперы крона тут неуместны — это другой секрет',
};

const GUARD = /\b(requireAdmin|verifyCronSecret|timingSafeCompare)\s*\(/;
const ACTION =
  /\b(pool\.query|query|db\.query|client\.query|withTransaction|callAIWaterfall|callAIFast|callAIDecision|fetch)\s*\(|\bBEGIN\b/;
const HANDLER = /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b/g;
/** Сравнение секрета руками: обе стороны — из словаря имён, которыми его зовут. */
const MANUAL_COMPARE =
  /\b(?:secret|provided|querySecret|cronSecret|expected|adminSecret)\s*(?:!==|===)\s*(?:secret|provided|querySecret|cronSecret|expected|adminSecret)\b/;
const QUERY_SECRET = /searchParams\.get\(\s*['"]secret['"]\s*\)/;

function routesUnder(dir: string): string[] {
  const acc: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === 'route.ts') acc.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, dir));
  return acc.sort();
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Имена локальных функций файла, в теле которых стоит признанная проверка. */
function localGuardHelpers(src: string): string[] {
  const names: string[] = [];
  const decl = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    const name = m[1] ?? m[2];
    if (!name || /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(name)) continue;
    const body = src.slice(m.index, m.index + 2500);
    if (GUARD.test(body)) names.push(name);
  }
  return names;
}

interface Verdict {
  file: string;
  problems: string[];
}

function judge(file: string): Verdict {
  const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
  const problems: string[] = [];

  if (MANUAL_COMPARE.test(src)) problems.push('секрет сравнивается === / !== — только timingSafeCompare или verifyCronSecret');
  if (QUERY_SECRET.test(src)) problems.push('секрет читается из ?secret= в роуте — разбор только в lib/auth/cron.ts');

  const helpers = localGuardHelpers(src);
  const helperCall = helpers.length ? new RegExp(`\\b(?:${helpers.join('|')})\\s*\\(`) : null;

  const handlers = [...src.matchAll(HANDLER)];
  if (handlers.length === 0) problems.push('не найден ни один экспортированный хендлер GET/POST/...');

  handlers.forEach((h, i) => {
    const start = h.index ?? 0;
    const end = i + 1 < handlers.length ? (handlers[i + 1].index ?? src.length) : src.length;
    const body = src.slice(start, end);
    const direct = body.search(GUARD);
    const viaHelper = helperCall ? body.search(helperCall) : -1;
    const guardAt = [direct, viaHelper].filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? -1;
    const actionAt = body.search(ACTION);
    const name = h[0].replace(/.*function\s+/, '');
    if (guardAt < 0) problems.push(`${name}: нет проверки (requireAdmin / verifyCronSecret / getCronSecret+timingSafeCompare)`);
    else if (actionAt >= 0 && actionAt < guardAt) problems.push(`${name}: действие стоит раньше проверки (действие@${actionAt}, проверка@${guardAt})`);
  });

  return { file, problems };
}

describe('периметр: admin и cron роуты проверяют доступ до действия', () => {
  const files = [...routesUnder('app/api/admin'), ...routesUnder('app/api/cron')];

  it('перепись нашла оба каталога целиком', () => {
    // Ноль файлов — отказ переписи, не чистый прогон (§4.0).
    expect(routesUnder('app/api/admin').length).toBeGreaterThan(100);
    expect(routesUnder('app/api/cron').length).toBeGreaterThan(100);
  });

  it('у каждого роута проверка есть, стоит первой и сделана хелпером', () => {
    const offenders = files
      .filter((f) => !(f in GUARD_EXCEPTIONS))
      .map(judge)
      .filter((v) => v.problems.length > 0)
      .map((v) => `${v.file}\n    ${v.problems.join('\n    ')}`);
    expect(
      offenders,
      'роут под /api/admin или /api/cron открыт анониму на Edge — проверка внутри обязана стоять ' +
        'первой и идти через requireAdmin / verifyCronSecret:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('исключения существуют на диске и по-прежнему без признанной проверки', () => {
    for (const [file, reason] of Object.entries(GUARD_EXCEPTIONS)) {
      expect(existsSync(join(ROOT, file)), `${file}: файла нет — уберите исключение`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
      const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      expect(GUARD.test(src), `${file}: проверка появилась — это больше не исключение`).toBe(false);
      // У исключения всё равно должно быть постоянное по времени сравнение.
      expect(src).toMatch(/timingSafeEqual|timingSafeCompare/);
    }
  });

  it('сторож ловит то, ради чего написан', () => {
    // Три формы, найденные переписью 01.09, — на синтетике, чтобы правило
    // не молчало после того, как живые нарушители починены.
    const late = `import { pool } from '@/lib/db-pool';
export async function GET(req: Request) {
  const rows = await pool.query('SELECT 1');
  if (!verifyCronSecret(req)) return new Response(null, { status: 401 });
  return Response.json(rows);
}`;
    const manual = `export async function GET(req: Request) {
  const secret = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (secret !== cronSecret) return new Response(null, { status: 401 });
  return Response.json({});
}`;
    const query = `export async function GET(req: Request) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (!verifyCronSecret(req)) return new Response(null, { status: 401 });
  return Response.json({ secret });
}`;
    const judgeSrc = (s: string) => {
      const problems: string[] = [];
      if (MANUAL_COMPARE.test(s)) problems.push('manual');
      if (QUERY_SECRET.test(s)) problems.push('query');
      const g = s.search(GUARD);
      const a = s.search(ACTION);
      if (g < 0) problems.push('none');
      else if (a >= 0 && a < g) problems.push('late');
      return problems;
    };
    expect(judgeSrc(late)).toEqual(['late']);
    expect(judgeSrc(manual)).toEqual(['manual', 'none']);
    expect(judgeSrc(query)).toEqual(['query']);
  });
});
