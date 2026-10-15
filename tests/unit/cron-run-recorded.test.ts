// @vitest-environment node
/**
 * У каждой записи реестра кронов есть отметка прогона — или названная причина,
 * почему её нет (аудит 15.10, P4-07).
 *
 * Запись 19.09 «наблюдатель без наблюдателя» закрыла пропуск по РАЗРЯДАМ:
 * вопрос «запускался ли вообще» стал задаваться всему реестру, а не одной
 * восьмой. Но не по ЗАПИСЯМ: у 21 записи из 55 стоял `agentId: null`, то есть
 * отметки в agent_run_history не было, и живость этих кронов не мерил никто.
 * Среди них — обработка лидов (SLA 2 часа; Watchdog видел только след — лиды
 * старше 2 ч, — но не сам запуск), напоминание о туре накануне и сторож
 * подписки MAX-бота, однажды уже молчавшего месяц без сигнала. А сторож
 * вебхука Telegram отметку писал, и реестр её просто не читал.
 *
 * Здесь две проверки:
 *  1. Данные реестра: `agentId: null` — только с причиной в
 *     KNOWN_NO_RUN_RECORD. Список самоустаревающий: появилась отметка —
 *     запись обязана уйти; роут пишет отметку, а реестр её не читает —
 *     красный (ровно случай сторожа вебхука до 15.10).
 *  2. Поведение четырёх кронов, подключённых 15.10: вызов роута с подменённой
 *     базой оставляет РОВНО одну строку прогона под agentId реестра — успех
 *     на успехе, отказ на отказе, ни одной при пропуске по аренде окна.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

// ── Подмены ────────────────────────────────────────────────────────────────

type SqlAnswer = (sql: string) => unknown[] | Error;
let answer: SqlAnswer = () => [];
const poolQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
  const out = answer(sql);
  if (out instanceof Error) throw out;
  return { rows: out, rowCount: out.length };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => poolQuery(sql, params) } }));

let lease: 'claimed' | 'held' = 'claimed';
vi.mock('@/lib/agents/cron-lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/cron-lease')>()),
  claimCronWindow: async () => lease,
}));

const leadProcess = vi.fn(async (_id: string) => {});
vi.mock('@/lib/services/operators/lead-processor.service', () => ({
  leadProcessor: { process: (id: string) => leadProcess(id) },
}));

const aiFast = vi.fn(async () => 'Завтра тур. Возьмите тёплую одежду.');
vi.mock('@/lib/ai/providers', () => ({ callAIFast: () => aiFast() }));

const maxFetch = vi.fn();
vi.mock('@/lib/max/max-fetch', () => ({
  maxFetch: (...a: unknown[]) => maxFetch(...a),
  maxBot: () => ({ api: { sendMessageToChat: async () => {} } }),
}));

let webhookCheck: { status: string } = { status: 'ok' };
vi.mock('@/lib/telegram/operator-availability', () => ({
  readPreviousDeliveryCheck: async () => null,
  checkAndRestoreWebhook: async () => webhookCheck,
}));

import { CRON_REGISTRY, type CronEntry } from '@/lib/agents/cron-registry';

const ROOT = process.cwd();
const WF_DIR = join(ROOT, '.github', 'workflows');

// ── 1. Данные реестра ─────────────────────────────────────────────────────

const NOT_YET = 'отметку прогона роут не пишет — подключение не сделано (аудит 15.10, P4-07: следующими партиями после первых четырёх)';

/**
 * Записи реестра без отметки прогона и почему. Только сокращать: подключил
 * отметку — проставь agentId и убери строку; тест заставит.
 */
const KNOWN_NO_RUN_RECORD: Record<string, string> = {
  'client-errors-census': `суточная перепись ошибок браузера и дайджест серверных: ${NOT_YET}`,
  'booking-auto-complete': `завершение подтверждённых броней после тура: ${NOT_YET}`,
  'tour-review-request': `просьба об отзыве по завершённым броням: ${NOT_YET}`,
  'trip-reminders': `напоминание туристу о поездке за 2 дня: ${NOT_YET}`,
  'ssr-sentinel': `недельный сторож SSR публичных листингов: ${NOT_YET}`,
  'kb-gap': `суточный разбор пробелов в знаниях Кузьмича: ${NOT_YET}`,
  'engagement': `напоминания туристам, смотревшим тур и не забронировавшим: ${NOT_YET}`,
  'smart-notify': `сопоставление новых туров с предпочтениями: ${NOT_YET}`,
  'enrich-routes': `писатель описаний мест партией 20: ${NOT_YET}`,
  'routes-cache': `обновление кэша описаний маршрутов: ${NOT_YET}`,
  'kuzmich-places': `рецензии Кузьмича для мест партией 20: ${NOT_YET}`,
  'import-routes': `импорт паспортов маршрутов и статей: ${NOT_YET}`,
  'evo-judge':
    'судья эволюции считает на раннере GitHub и в прод ходит только читать находки (evo-issues): ' +
    'отметку на проде писать некому; живость судьи — прогоны самого workflow',
  'evo-review':
    'AI-ревью идёт на раннере GitHub; прод отдаёт список файлов (evo-review-job) и принимает находки ' +
    `(evo-findings), но приём отметку прогона не пишет — ${NOT_YET}`,
  'kuzmich-route': 'одна ручка /api/cron/kuzmich на три поста (?type=route|tip|tour): отметка обязана различать пост, ' +
    'иначе живость одного читалась бы по прогонам другого — не сделано (аудит 15.10, P4-07)',
  'kuzmich-tip': 'та же ручка /api/cron/kuzmich, пост-совет (?type=tip): отметка обязана различать пост — не сделано (аудит 15.10, P4-07)',
  'kuzmich-tour': 'та же ручка /api/cron/kuzmich, пост о туре (?type=tour): отметка обязана различать пост — не сделано (аудит 15.10, P4-07)',
};

/** Эндпоинты записи: своё поле или адреса её workflow вне комментариев. */
function endpointsOf(e: CronEntry): string[] {
  if (e.endpoint) return [e.endpoint];
  const wf = join(WF_DIR, e.workflow);
  if (!existsSync(wf)) return [];
  const code = readFileSync(wf, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  return [...new Set([...code.matchAll(/\/api\/cron\/([a-z0-9-]+)/g)].map((m) => m[1]))];
}

/** Пишет ли роут отметку прогона сам — по одному из трёх писателей. */
function routeWritesRunRecord(ep: string): boolean {
  const f = join(ROOT, 'app', 'api', 'cron', ep, 'route.ts');
  if (!existsSync(f)) return false;
  const src = readFileSync(f, 'utf8');
  return /\brecordCronRun\(|\blogAgentRun\(|INSERT INTO agent_run_history/.test(src);
}

describe('реестр: отметка прогона или причина', () => {
  it('реестр прочитан и записи без отметки найдены', () => {
    // Ноль при нулевом входе — отказ, а не успех (§4.0).
    expect(CRON_REGISTRY.length).toBeGreaterThan(40);
  });

  for (const e of CRON_REGISTRY) {
    it(`${e.key}: ${e.agentId ? `отметка '${e.agentId}'` : 'без отметки — названа причина'}`, () => {
      const why = KNOWN_NO_RUN_RECORD[e.key];
      if (e.agentId !== null) {
        expect(why, `${e.key} пишет отметку '${e.agentId}', а числится в KNOWN_NO_RUN_RECORD — запись устарела, убери её`).toBeUndefined();
        return;
      }
      expect(why, `${e.key}: agentId: null без причины. Подключи recordCronRun под ключом реестра или назови причину в KNOWN_NO_RUN_RECORD`).toBeTruthy();
      expect(String(why).length, 'причина не может быть отпиской').toBeGreaterThan(40);
      // Обратная ложь: отметка пишется, а реестр её не читает — живость
      // меряется по пустоте. Так стоял сторож вебхука Telegram до 15.10.
      const writers = endpointsOf(e).filter(routeWritesRunRecord);
      expect(writers, `${e.key}: роут ${writers.join(', ')} пишет отметку прогона, а реестр держит agentId: null — проставь его`).toEqual([]);
    });
  }

  it('в KNOWN_NO_RUN_RECORD нет ключей, которых нет в реестре', () => {
    const keys = new Set(CRON_REGISTRY.map((e) => e.key));
    const phantom = Object.keys(KNOWN_NO_RUN_RECORD).filter((k) => !keys.has(k));
    expect(phantom).toEqual([]);
  });
});

// ── 2. Поведение четырёх кронов, подключённых 15.10 ───────────────────────

interface RunRow { agentId: string; status: string }

/** Строки agent_run_history из вызовов базы: logAgentRun или свой INSERT роута. */
function runRows(): RunRow[] {
  return poolQuery.mock.calls
    .filter((c) => /INSERT INTO agent_run_history/.test(String(c[0])))
    .map((c) => {
      const sql = String(c[0]);
      const params = c[1] ?? [];
      // Свой INSERT роута держит имя агента литералом: VALUES ('имя', $1, ...)
      const lit = /VALUES\s*\(\s*'([^']+)'\s*,\s*\$1/.exec(sql);
      return lit
        ? { agentId: lit[1], status: String(params[0]) }
        : { agentId: String(params[0]), status: String(params[1]) };
    });
}

function agentOf(key: string): string {
  const e = CRON_REGISTRY.find((x) => x.key === key);
  expect(e, `ключа ${key} нет в реестре`).toBeDefined();
  expect(e!.agentId, `${key}: в реестре agentId: null`).not.toBeNull();
  return e!.agentId!;
}

const authed = (path: string) => new NextRequest(`https://vedarai.ru${path}`, { headers: { authorization: 'Bearer cron-test' } });
const dbDown = () => Object.assign(new Error('connection terminated'), { code: '57P01' });

beforeEach(() => {
  poolQuery.mockClear();
  answer = () => [];
  lease = 'claimed';
  leadProcess.mockReset();
  leadProcess.mockResolvedValue(undefined);
  aiFast.mockReset();
  aiFast.mockResolvedValue('Завтра тур. Возьмите тёплую одежду.');
  maxFetch.mockReset();
  webhookCheck = { status: 'ok' };
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok');
  vi.stubEnv('MAX_BOT_TOKEN', 'max-token');
  vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://vedarai.ru');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('leads-process — отметка под ключом реестра leads', () => {
  const call = async () => (await import('@/app/api/cron/leads-process/route')).GET(authed('/api/cron/leads-process'));

  it('разобрал выборку — одна строка success', async () => {
    answer = (sql) => (/FROM leads/.test(sql) ? [{ id: 'l1', name: 'x' }, { id: 'l2', name: 'y' }] : []);
    const res = await call();
    expect(res.status).toBe(200);
    expect(runRows()).toEqual([{ agentId: agentOf('leads'), status: 'success' }]);
  });

  it('лидов нет — тоже прогон, и он отмечен', async () => {
    await call();
    expect(runRows()).toEqual([{ agentId: agentOf('leads'), status: 'success' }]);
  });

  it('ни одного разобранного при непустой выборке — failed', async () => {
    answer = (sql) => (/FROM leads/.test(sql) ? [{ id: 'l1', name: 'x' }] : []);
    leadProcess.mockRejectedValue(new Error('model down'));
    await call();
    expect(runRows()).toEqual([{ agentId: agentOf('leads'), status: 'failed' }]);
  });

  it('база упала на выборке — failed и 500, а не немой отказ', async () => {
    answer = (sql) => (/FROM leads/.test(sql) ? dbDown() : []);
    const res = await call();
    expect(res.status).toBe(500);
    expect(runRows()).toEqual([{ agentId: agentOf('leads'), status: 'failed' }]);
  });

  it('окно занято другим планировщиком — отметки нет: её ставит тот, кто работал', async () => {
    lease = 'held';
    await call();
    expect(runRows()).toEqual([]);
  });
});

describe('tour-reminder — отметка под ключом реестра tour-reminder', () => {
  const call = async () => (await import('@/app/api/cron/tour-reminder/route')).GET(authed('/api/cron/tour-reminder'));
  const booking = { id: 21, tourist_name: 'x', booking_date: '2026-10-16', participants: 2, tour_title: 'Авачинский', activity_type: null, location_name: null, difficulty: null, tg_chat_id: 555, platform: 'telegram' };

  it('туров на завтра нет — прогон отмечен успехом', async () => {
    await call();
    expect(runRows()).toEqual([{ agentId: agentOf('tour-reminder'), status: 'success' }]);
  });

  it('напоминание собрано — success', async () => {
    answer = (sql) => (/reminder_sent_24h = false/.test(sql) ? [booking] : []);
    await call();
    expect(runRows()).toEqual([{ agentId: agentOf('tour-reminder'), status: 'success' }]);
  });

  it('модель не ответила ни на одну бронь — failed, а не «отправлено 0»', async () => {
    answer = (sql) => (/reminder_sent_24h = false/.test(sql) ? [booking] : []);
    aiFast.mockResolvedValue('');
    await call();
    expect(runRows()).toEqual([{ agentId: agentOf('tour-reminder'), status: 'failed' }]);
  });

  it('база упала на выборке — failed и 500', async () => {
    answer = (sql) => (/reminder_sent_24h = false/.test(sql) ? dbDown() : []);
    const res = await call();
    expect(res.status).toBe(500);
    expect(runRows()).toEqual([{ agentId: agentOf('tour-reminder'), status: 'failed' }]);
  });
});

describe('max-webhook — отметка под ключом реестра max-webhook', () => {
  const call = async () => (await import('@/app/api/cron/max-webhook/route')).GET(new Request('https://vedarai.ru/api/cron/max-webhook', { headers: { authorization: 'Bearer cron-test' } }));

  it('подписка на месте — success', async () => {
    maxFetch.mockResolvedValue(new Response(JSON.stringify({ subscriptions: [{ url: 'https://vedarai.ru/api/max/kuzmich' }] }), { status: 200 }));
    const res = await call();
    expect(res.status).toBe(200);
    expect(runRows()).toEqual([{ agentId: agentOf('max-webhook'), status: 'success' }]);
  });

  it('MAX недоступен — failed и 502', async () => {
    maxFetch.mockRejectedValue(new Error('fetch failed'));
    const res = await call();
    expect(res.status).toBe(502);
    expect(runRows()).toEqual([{ agentId: agentOf('max-webhook'), status: 'failed' }]);
  });

  it('токена нет — failed, а не немой 500', async () => {
    vi.stubEnv('MAX_BOT_TOKEN', '');
    const res = await call();
    expect(res.status).toBe(500);
    expect(runRows()).toEqual([{ agentId: agentOf('max-webhook'), status: 'failed' }]);
  });

  it('без секрета — ни работы, ни отметки', async () => {
    const res = await (await import('@/app/api/cron/max-webhook/route')).GET(new Request('https://vedarai.ru/api/cron/max-webhook'));
    expect(res.status).toBe(401);
    expect(runRows()).toEqual([]);
  });
});

describe('telegram-webhook-watchdog — реестр читает ту строку, что роут пишет и раньше', () => {
  const call = async () => (await import('@/app/api/cron/telegram-webhook-watchdog/route')).GET(new Request('https://vedarai.ru/api/cron/telegram-webhook-watchdog', { headers: { authorization: 'Bearer cron-test' } }));

  it('проверка прошла — ровно одна строка success под agentId реестра (второй строки на прогон нет)', async () => {
    await call();
    expect(runRows()).toEqual([{ agentId: agentOf('tg-watchdog'), status: 'success' }]);
  });

  it('проверка не удалась — одна строка failed', async () => {
    webhookCheck = { status: 'failed' };
    await call();
    expect(runRows()).toEqual([{ agentId: agentOf('tg-watchdog'), status: 'failed' }]);
  });

  it('окно занято — строки нет', async () => {
    lease = 'held';
    await call();
    expect(runRows()).toEqual([]);
  });
});
