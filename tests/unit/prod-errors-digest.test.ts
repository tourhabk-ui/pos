// @vitest-environment node
/**
 * Серверные ошибки — владельцу, и без ПД (аудит 15.10: P4-17 и Д4-4).
 *
 * До 15.10 серверные ошибки прода доходили до владельца только через суточный
 * объектив эволюции и GitHub Issue — сутки спустя и не ему. При этом
 * `onRequestError` писал текст ошибки и кадры стека как есть: почта из формы,
 * телефон из ключа уникальности, адрес с ключом в query уходили в журнал, из
 * журнала — в находку эволюции и промпт, а дайджест в Telegram вынес бы их
 * туда, куда ПД по решению владельца 23.08 не ходят (в Telegram — номер дела и
 * ссылка, docs/safety/WATCH_DESIGN.md).
 *
 * Проверяется поведение, вызовом:
 *  - перехватчик чистит текст, стек, путь и маршрут ДО записи;
 *  - перепись с ?notify=1 шлёт дайджест через tgSend, и в тексте нет ни ПД
 *    (даже из строк, записанных до чистки), ни стеков;
 *  - счётчики названы нижней границей — и в тексте, и в ответе;
 *  - недоставка — не «ок»: 502 и ok:false с причиной; «ошибок нет» — без
 *    отправки; упавшая перепись — без отправки и 500;
 *  - запускает дайджест второй шаг существующего суточного workflow, а не
 *    новое расписание.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

// ── Подмены ────────────────────────────────────────────────────────────────

const dbQuery = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));

let poolAnswer: () => unknown[] | Error = () => [];
const poolQuery = vi.fn(async () => {
  const out = poolAnswer();
  if (out instanceof Error) throw out;
  return { rows: out, rowCount: out.length };
});
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...(a as [])) } }));

import { onRequestError } from '@/instrumentation';
import { GET } from '@/app/api/cron/prod-errors/route';
import {
  ROUTE_LIMIT, DIGEST_TOP, serverErrorsDigestText, type ServerErrorRow,
} from '@/lib/server-errors/digest';
import { ERROR_LOG_THROTTLE_MS } from '@/lib/server-errors/log-throttle';

// Что считается утечкой: почта, телефон, токен, query с ключом.
const EMAIL = 'ivan.petrov@mail.ru';
const PHONE = '+7 999 123-45-67';
const TOKEN = 'Bearer abcdef1234567890';
const QUERY_KEY = 'key=deadbeefcafe';
const LEAKS = [EMAIL, PHONE, '79991234567', TOKEN, QUERY_KEY, 'abcdef1234567890'];

function expectNoLeaks(text: string, where: string) {
  for (const leak of LEAKS) expect(text, `${where}: утекло «${leak}»`).not.toContain(leak);
}

const DIRTY_MESSAGE =
  `duplicate key: Key (email)=(${EMAIL}) phone ${PHONE}; auth ${TOKEN}; ` +
  `fetch https://api.example.com/v1/x?${QUERY_KEY}&phone=79991234567 failed`;

function row(over: Partial<ServerErrorRow> = {}): ServerErrorRow {
  return {
    route: '/api/tours/[id]/slots',
    method: 'GET',
    kind: 'route',
    n: 12,
    first_at: '2026-10-14 20:00:00+00',
    last_at: '2026-10-15 06:10:00+00',
    last_message: DIRTY_MESSAGE,
    paths: [`/api/tours/51/slots`],
    last_digest: '2817395042',
    last_stack: `at handler (/app/.next/server/x.js:1:2) | at mail ${EMAIL}`,
    ...over,
  };
}

function get(qs: string, secret = 'cron-test') {
  return GET(new NextRequest(`http://localhost/api/cron/prod-errors${qs}`, {
    headers: { Authorization: `Bearer ${secret}` },
  }));
}

const sent: Array<{ url: string; text: string }> = [];
let telegramStatus = 200;

beforeEach(() => {
  dbQuery.mockReset();
  dbQuery.mockResolvedValue({ rows: [] });
  poolQuery.mockClear();
  poolAnswer = () => [];
  sent.length = 0;
  telegramStatus = 200;
  process.env.NEXT_RUNTIME = 'nodejs';
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok');
  vi.stubEnv('TELEGRAM_CHAT_ID', '42');
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
    sent.push({ url: String(url), text: String(body.text ?? '') });
    return new Response(telegramStatus === 200 ? '{"ok":true}' : '{"ok":false,"description":"Forbidden: bot was blocked"}', { status: telegramStatus });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ── Д4-4: чистка на входе ─────────────────────────────────────────────────

describe('onRequestError чистит ДО записи', () => {
  it('текст, стек, путь и маршрут без ПД, ключей и query', async () => {
    const err = new Error(DIRTY_MESSAGE);
    err.stack = `Error: x\n    at save (/app/lib/leads.ts:10:5) ${EMAIL}\n    at call ${TOKEN}\n    at run (https://vedarai.ru/x?${QUERY_KEY})`;
    // routePath нет — маршрутом становится сам адрес, и query в нём быть не должно.
    await onRequestError(err, { path: `/api/leads/${EMAIL}?${QUERY_KEY}&phone=79991234567`, method: 'POST' }, { routeType: 'route' });

    expect(dbQuery).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(String((dbQuery.mock.calls[0][1] as unknown[])[1])) as Record<string, string | null>;
    expectNoLeaks(String(meta.message), 'message');
    expectNoLeaks(String(meta.stack), 'stack');
    expectNoLeaks(String(meta.path), 'path');
    expectNoLeaks(String(meta.route), 'route');
    expect(meta.message).toContain('[email]');
    expect(meta.message).toContain('[телефон]');
    expect(meta.route).not.toContain('?');
    // Полезное остаётся: смысл ошибки и кадр стека.
    expect(meta.message).toContain('duplicate key');
    expect(meta.stack).toContain('at save');
  });

  it('ошибка без стека — честный null, а не пустая строка', async () => {
    const err = new Error('plain');
    err.stack = undefined;
    await onRequestError(err, { path: '/api/plain-no-stack', method: 'GET' }, { routePath: '/api/plain-no-stack-test', routeType: 'route' });
    const meta = JSON.parse(String((dbQuery.mock.calls[0][1] as unknown[])[1])) as Record<string, unknown>;
    expect(meta.stack).toBeNull();
  });
});

// ── P4-17: дайджест ───────────────────────────────────────────────────────

describe('GET /api/cron/prod-errors?notify=1 — дайджест владельцу', () => {
  it('шлёт через Telegram: счётчики нижней границей, без ПД и стеков — даже из старых строк', async () => {
    poolAnswer = () => [row(), row({ route: '/routes/[id]', kind: 'render', n: 5, last_message: 'An error occurred in the Server Components render.' })];
    const res = await get('?hours=25&notify=1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.notify).toEqual({ sent: true, reason: 'доставлен' });
    expect(body.total).toBe(17);
    expect(body.total_is_lower_bound).toBe(true);
    expect(body.note).toContain('нижняя граница');

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/bottok/sendMessage');
    const text = sent[0].text;
    expectNoLeaks(text, 'Telegram');
    expect(text).toContain('не меньше 17');
    expect(text).toContain('нижняя граница');
    expect(text).toContain(`${Math.round(ERROR_LOG_THROTTLE_MS / 1000)} с`);
    expect(text).toContain('/api/tours/[id]/slots');
    expect(text).toContain('не меньше 12');
    // Стеки и конкретные адреса — не в Telegram.
    expect(text).not.toContain('at handler');
    expect(text).not.toContain('/api/tours/51/slots');

    // Ответ переписи — тоже чистый: строки до 15.10 записаны без чистки.
    const json = JSON.stringify(body);
    expectNoLeaks(json, 'ответ переписи');
  });

  it('Telegram отказал — ok:false и 502 с причиной, а не зелёный прогон', async () => {
    poolAnswer = () => [row()];
    telegramStatus = 403;
    const res = await get('?hours=25&notify=1');
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.notify.sent).toBe(false);
    expect(body.notify.reason).toContain('403');
    // Данные при этом не потеряны: перепись видна и при недоставке.
    expect(body.total).toBe(12);
  });

  it('канал не настроен — тоже недоставка, а не тишина', async () => {
    poolAnswer = () => [row()];
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const res = await get('?hours=25&notify=1');
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.notify.reason).toContain('TELEGRAM_BOT_TOKEN');
    expect(sent).toHaveLength(0);
  });

  it('ошибок нет — ничего не шлёт и так и говорит', async () => {
    poolAnswer = () => [];
    const res = await get('?hours=25&notify=1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.notify).toEqual({ sent: false, reason: 'ошибок нет' });
    expect(sent).toHaveLength(0);
  });

  it('перепись упала — 500, ok:false, слать нечего, и это не «ошибок нет»', async () => {
    poolAnswer = () => Object.assign(new Error('relation missing'), { code: '42P01' });
    const res = await get('?hours=25&notify=1');
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.notify.sent).toBe(false);
    expect(body.notify.reason).not.toBe('ошибок нет');
    expect(sent).toHaveLength(0);
  });

  it('без ?notify=1 — только перепись, в Telegram ничего', async () => {
    poolAnswer = () => [row()];
    const body = await (await get('?hours=25')).json();
    expect(body.ok).toBe(true);
    expect(body.notify).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('без секрета — 401 и ни запроса к базе, ни отправки', async () => {
    const res = await get('?notify=1', 'wrong');
    expect(res.status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe('serverErrorsDigestText — границы', () => {
  it('упёрлись в потолок переписи — и маршрутов «не меньше»', () => {
    const rows = Array.from({ length: ROUTE_LIMIT }, (_, i) => row({ route: `/api/r${i}`, n: 1 }));
    const text = serverErrorsDigestText(25, rows, true);
    expect(text).toContain(`маршрутов не меньше ${ROUTE_LIMIT}`);
    expect(text).toContain(`Остальные маршруты: не меньше ${ROUTE_LIMIT - DIGEST_TOP}`);
    // Поимённо — только верх списка.
    expect(text).toContain('/api/r0');
    expect(text).not.toContain(`/api/r${DIGEST_TOP}`);
  });

  it('HTML экранируется, длина в потолке Telegram', () => {
    const text = serverErrorsDigestText(25, [row({ last_message: '<script>alert(1)</script>'.repeat(50) })], false);
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
    expect(text.length).toBeLessThanOrEqual(3500);
  });

  it('текст ошибки не записан — так и сказано', () => {
    expect(serverErrorsDigestText(25, [row({ last_message: null })], false)).toContain('текст не записан');
  });
});

// ── Запуск: второй шаг существующего workflow ─────────────────────────────

describe('дайджест зовёт существующий суточный workflow, а не новое расписание', () => {
  type Step = { name?: string; if?: string; run?: string };
  const wf = load(readFileSync(join(process.cwd(), '.github/workflows/cron-client-errors.yml'), 'utf8')) as {
    on: { schedule: Array<{ cron: string }> };
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const digest = steps.find((s) => (s.run ?? '').includes('/api/cron/prod-errors'));

  it('в файле по-прежнему одно расписание', () => {
    expect(wf.on.schedule).toEqual([{ cron: '17 19 * * *' }]);
  });

  it('шаг зовёт перепись с окном 25 ч и notify, и идёт после отказа первого шага', () => {
    expect(digest, 'шага с /api/cron/prod-errors нет').toBeDefined();
    expect(digest!.run).toContain('/api/cron/prod-errors?hours=25&notify=1');
    expect(digest!.if).toBe('${{ !cancelled() }}');
    expect(steps.indexOf(digest!)).toBeGreaterThan(0);
  });

  it('не 200 — шаг красный, а не «всё хорошо»', () => {
    expect(digest!.run).toMatch(/if \[ "\$CODE" != "200" \]; then[\s\S]*?exit 1/);
  });

  it('в лог прогона не печатается текст ошибок и стеки', () => {
    // Печатается только сокращённая форма: маршрут, род, метод, счётчик.
    expect(digest!.run).not.toMatch(/last_message|last_stack|paths/);
    expect(digest!.run).not.toMatch(/jq '\.'/);
  });
});
