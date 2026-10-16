/**
 * GET /api/cron/agent-entry-census — перепись краулеров по семействам у входов
 * для агентов. Только чтение.
 *
 * Решение владельца 12.10 («го» на китайский слой для агентов). Вопрос
 * «приходят ли к нам Baidu, ByteDance, Huawei» до этого дня не имел источника:
 * page_views пишется браузерным скриптом, который обходчик не исполняет,
 * middleware не видит robots.txt и /.well-known/*, журнал MCP считает только
 * вызовы инструментов. Счётчик ведёт lib/analytics/agent-entry-hits (сутки ×
 * путь × семейство, без User-Agent и IP); эта перепись его читает.
 *
 * Три исхода (§4.0): числа по семействам; «за окно ни одного запроса» с
 * датой первой записи счётчика — чтобы ноль с только что заведённой таблицы
 * не читался как «никто не ходит»; и «не прочиталось» — 503 с SQLSTATE в логе.
 * Что НЕ считается, названо в ответе (`not_counted`), а не подразумевается.
 *
 * Запуск — west-knowledge-probe.yml по маркеру (с 16.10: обходчики OpenAI,
 * Anthropic и Perplexity рядом с вопросом ChatGPT и Grok), рукой или из
 * prod-check.json. Раз её зовёт workflow, в cron-schedulers она не объявляется.
 * Сторож: tests/unit/agents-china-layer.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { BOT_FAMILIES } from '@/lib/analytics/bot-detect';
import { AGENT_ENTRY_PATHS } from '@/lib/analytics/agent-entry-paths';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

/** Семейства КНР — ради них перепись и заведена; отдельной строкой в ответе. */
// kimi — с аудита 15.10 (CN-detect): без строки здесь семейство считалось бы,
// но в группе КНР его не было бы вовсе, и «Kimi не приходит» не читалось бы ниоткуда.
export const CHINESE_FAMILIES = ['baidu', 'bytedance', 'huawei', 'alibaba', 'tencent', '360', 'deepseek', 'kimi'] as const;

/**
 * Чего счётчик не видит — вслух, чтобы ноль не читался как «не ходят».
 * С аудита 15.10 (CN-quick) /sitemap.xml и китайский вход /zh считаются, и из
 * списка ушли; на /zh не считаются люди — их визиты пишет page_views.
 */
export const NOT_COUNTED = [
  'HTML-страницы, кроме /zh: счётчик page_views пишется браузерным скриптом, обходчик его не исполняет',
  'люди на /zh: браузер человека здесь не считается — это перепись обходчиков, людей считает page_views',
  '/api/mcp и /api/a2a: вызовы инструментов считает mcp-census (mcp_clients.ua_family), агентов A2A — a2a-census',
  // Аудит 15.10, W3-china (ревью CN-quick): счётчик стоит в роуте, а ответ
  // машинного файла разрешено хранить общему кэшу. Стоит ли такой кэш перед
  // продом, репозиторий не знает, поэтому оговорка условная. Срок s-maxage
  // здесь равен заголовку карты сайта — это держит сторож china-quick вызовом
  // обоих роутов. /zh не затронут: HTML отдаётся с no-store (next.config.js).
  'повторы, отданные общим кэшем (CDN, кэширующий прокси), если он стоит перед продом: /sitemap.xml '
    + 'отдаётся с public, s-maxage=3600, у llms.txt, манифестов и OpenAPI тоже публичный Cache-Control — '
    + 'повтор в срок кэша до роута не доходит; счётчик видит промахи кэша, и малое число не значит «не ходят»',
] as const;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

interface FamilyRow { family: string; hits: number }
interface PathRow { path: string; family: string; hits: number }
interface DayRow { day: string; hits: number }
interface BoundsRow { first_day: string | null; last_day: string | null; total: number }

export function readDays(raw: string | null): number {
  const n = Number(raw ?? DEFAULT_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : DEFAULT_DAYS;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const days = readDays(request.nextUrl.searchParams.get('days'));
  const vendorOf = new Map(BOT_FAMILIES.map((f) => [f.family, f.vendor]));

  try {
    const [byFamily, byPath, byDay, bounds] = await Promise.all([
      pool.query<FamilyRow>(
        `SELECT family, SUM(hits)::int AS hits
           FROM agent_entry_hits
          WHERE day >= CURRENT_DATE - ($1::int - 1)
          GROUP BY family
          ORDER BY hits DESC, family ASC`,
        [days],
      ),
      pool.query<PathRow>(
        `SELECT path, family, SUM(hits)::int AS hits
           FROM agent_entry_hits
          WHERE day >= CURRENT_DATE - ($1::int - 1)
          GROUP BY path, family
          ORDER BY path ASC, hits DESC, family ASC`,
        [days],
      ),
      pool.query<DayRow>(
        `SELECT day::text AS day, SUM(hits)::int AS hits
           FROM agent_entry_hits
          WHERE day >= CURRENT_DATE - ($1::int - 1)
          GROUP BY day
          ORDER BY day ASC`,
        [days],
      ),
      pool.query<BoundsRow>(
        `SELECT MIN(day)::text AS first_day, MAX(day)::text AS last_day, COALESCE(SUM(hits), 0)::int AS total
           FROM agent_entry_hits`,
      ),
    ]);

    const families = byFamily.rows.map((r) => ({ family: r.family, vendor: vendorOf.get(r.family) ?? null, hits: r.hits }));
    const windowTotal = families.reduce((s, f) => s + f.hits, 0);
    const chinese = CHINESE_FAMILIES.map((family) => ({
      family,
      vendor: vendorOf.get(family) ?? null,
      hits: families.find((f) => f.family === family)?.hits ?? 0,
    }));
    const b = bounds.rows[0] ?? { first_day: null, last_day: null, total: 0 };

    return NextResponse.json({
      ok: true,
      window_days: days,
      window_total: windowTotal,
      // Пусто за окно — не «никто не ходит», пока не видно, с какого дня
      // счётчик вообще считает.
      empty: windowTotal === 0,
      counter_first_day: b.first_day,
      counter_last_day: b.last_day,
      counter_total_all_time: b.total,
      note: windowTotal === 0
        ? (b.first_day
          ? `за ${days} дн. ни одного запроса к входам; счётчик ведётся с ${b.first_day}`
          : 'счётчик ещё ничего не видел: таблица пуста — считать он начал с этого деплоя')
        : null,
      counted_paths: AGENT_ENTRY_PATHS,
      not_counted: NOT_COUNTED,
      chinese_families: chinese,
      by_family: families,
      by_path: byPath.rows,
      by_day: byDay.rows,
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error(
      '[agent-entry-census] перепись не прочитала agent_entry_hits:',
      typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '',
      logText(err instanceof Error ? err.message : err, 200),
    );
    return NextResponse.json(
      { ok: false, error: 'перепись не смогла прочитать agent_entry_hits — это отказ, а не «запросов нет»' },
      { status: 503 },
    );
  }
}
