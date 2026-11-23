/**
 * Тревога сторожа обязана дойти — и недоставка обязана быть видна.
 *
 * Аудит агентов 23.11 (слово владельца: «изучи работу агентов, найди дыры»):
 *  1. Текст тревог уходил в Telegram как HTML без экранирования. Знак «<» в
 *     тексте ошибки базы или упавшего крона — Telegram отвечает 400 на всё
 *     сообщение, вместе с SOS. Отметка «отправлено» при отказе не ставится,
 *     и следующий прогон слал то же самое: сторож молчал.
 *  2. Отказ доставки не входил в статус прогона — немой сторож в журнале
 *     был зелёным, а за самим сторожем не следил никто.
 *  3. «Брони без подтверждения» шлись каждый час: в тексте растут часы.
 *  4. Шаг workflow печатал тело ответа (тексты тревог) в публичный лог.
 *
 * Судится поведением: сборка текста, прогон сторожа на подменах базы и
 * Telegram, правило статуса, шаг второй ноги.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) =>
      String(sql).includes('FROM mcp_tool_calls')
        ? Promise.resolve({ rows: [{ calls: '5', callers: '2' }] })
        : poolQueryMock(sql, params),
  },
}));

vi.mock('@/lib/agents/memory/agent-knowledge', () => ({
  knowledgeBase: {
    upsert: vi.fn().mockResolvedValue(undefined),
    appendTimeline: vi.fn().mockResolvedValue(undefined),
  },
}));

const memoryGetMock = vi.fn<(agentId: string, type: string, key: string) => Promise<unknown>>();
const memoryRememberMock = vi.fn<(params: unknown) => Promise<void>>();
vi.mock('@/lib/agents/memory/agent-memory', () => ({
  agentMemory: {
    get: (...args: [string, string, string]) => memoryGetMock(...args),
    remember: (...args: [unknown]) => memoryRememberMock(...args),
  },
}));

vi.mock('@/lib/mcp/catalogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp/catalogs')>()),
  MCP_SILENCE_ALERT_FROM_DAYS: Number.POSITIVE_INFINITY,
}));

import { runWatchdog } from '@/lib/agents/watchdog';
import { buildWatchdogMessage, rejectedAsBadMessage, WATCHDOG_MESSAGE_LIMIT } from '@/lib/agents/watchdog-message';
import { watchdogRunVerdict } from '@/lib/agents/watchdog-verdict';
import { watchdogStepVerdict, LAST_RUN_STALE_MIN } from '../../scripts/watchdog-step.mjs';

const HTML_ERROR = `Unexpected token '<', "<!DOCTYPE "... is not valid JSON & more`;

let errSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  poolQueryMock.mockReset();
  memoryGetMock.mockReset();
  memoryGetMock.mockResolvedValue(null);
  memoryRememberMock.mockReset();
  memoryRememberMock.mockResolvedValue(undefined);
  process.env.NEXT_PUBLIC_VAPID_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.TELEGRAM_BOT_TOKEN = 't';
  process.env.TELEGRAM_CHAT_ID = 'c';
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });
  vi.stubGlobal('fetch', fetchMock);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** Тела запросов к Telegram по порядку. */
function sentBodies(): Array<{ text: string; parse_mode?: string }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes('/sendMessage'))
    .map((c) => JSON.parse((c[1] as { body: string }).body) as { text: string; parse_mode?: string });
}

/** Все проверки падают с текстом ошибки, в котором есть «<» и «&». */
function everyCheckFailsWithHtmlError() {
  poolQueryMock.mockImplementation(() => Promise.reject(new Error(HTML_ERROR)));
}

/** Одна забытая бронь: число то же, возраст задаётся. */
function oneUnconfirmedBooking(hours: number) {
  poolQueryMock.mockImplementation((sql: string) => {
    const q = String(sql);
    if (q.includes("booking_status = 'new'") && q.includes('oldest_hours')) {
      return Promise.resolve({ rows: [{ count: '1', oldest_hours: String(hours) }] });
    }
    if (q.includes('FROM _migrations')) return Promise.resolve({ rows: [{ name: 'x' }] });
    if (q.includes('agent_run_history')) return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('текст тревоги: чужие строки экранированы, разметка только наша', () => {
  const input = {
    due: [
      { critical: false, details: 'Крон kvert-acc падает подряд: <!DOCTYPE html> & <b>не наше</b>' },
      { critical: true, details: 'SOS без реакции 20 мин, координаты: 53.02, 158.65' },
    ],
    suppressedCount: 2,
    debounceHours: 12,
    failed: [{ check: 'checkStay', reason: HTML_ERROR }],
    checksTotal: 28,
    adminUrl: 'https://vedarai.ru',
  };

  it('знаки «<», «>», «&» из чужого текста уходят сущностями', () => {
    const { html } = buildWatchdogMessage(input);
    expect(html).toContain('&lt;!DOCTYPE html&gt; &amp; &lt;b&gt;не наше&lt;/b&gt;');
    expect(html).toContain('&lt;!DOCTYPE &quot;... is not valid JSON &amp; more');
    // Сырого «<» вне наших тегов не осталось: всё, что начинается с «<», — b или a.
    const tags = html.match(/<[^>]*>/g) ?? [];
    expect(tags.every((t) => /^<\/?(b|a)(\s|>)/.test(t)), `посторонний тег: ${tags.join(' ')}`).toBe(true);
  });

  it('критическая тревога стоит первой', () => {
    const { html } = buildWatchdogMessage(input);
    expect(html.indexOf('КРИТ: SOS без реакции')).toBeGreaterThan(0);
    expect(html.indexOf('КРИТ: SOS без реакции')).toBeLessThan(html.indexOf('ВНИМАНИЕ: Крон kvert-acc'));
  });

  it('простой текст — без тегов и без сущностей, со ссылкой на панель', () => {
    const { plain } = buildWatchdogMessage(input);
    // Нашей разметки нет; чужой текст остаётся как был — Telegram его не разбирает.
    expect(plain).not.toContain('<b>Watchdog');
    expect(plain).not.toContain('<a href');
    expect(plain).not.toContain('&lt;');
    expect(plain).toContain('<!DOCTYPE html> & <b>не наше</b>');
    expect(plain).toContain('https://vedarai.ru/hub/admin');
  });

  it('двести тревог укладываются в предел Telegram, КРИТ не отрезан, отрезанное названо числом', () => {
    const due = [
      ...Array.from({ length: 200 }, (_, i) => ({ critical: false, details: `Нарушение ${i}: ${'текст '.repeat(12)}` })),
      { critical: true, details: 'SOS без реакции 20 мин' },
    ];
    const m = buildWatchdogMessage({ ...input, due });
    expect(m.html.length).toBeLessThanOrEqual(4096);
    expect(m.html.length).toBeLessThanOrEqual(WATCHDOG_MESSAGE_LIMIT + 200);
    expect(m.html).toContain('КРИТ: SOS без реакции 20 мин');
    expect(m.dropped).toBeGreaterThan(0);
    expect(m.html).toContain(`и ещё ${m.dropped} — не поместились`);
    expect(m.html).toContain('Открыть панель');
  });

  it('одна тревога длиннее предела — урезается, а не пропадает', () => {
    const m = buildWatchdogMessage({ ...input, due: [{ critical: true, details: 'А'.repeat(9000) }], failed: [] });
    expect(m.html.length).toBeLessThanOrEqual(4096);
    expect(m.html).toContain('КРИТ: ААА');
  });

  it('повтор простым текстом — только когда Telegram отверг само сообщение', () => {
    expect(rejectedAsBadMessage(`Telegram ответил 400: {"description":"Bad Request: can't parse entities"}`)).toBe(true);
    expect(rejectedAsBadMessage('Telegram ответил 403: bot was blocked by the user')).toBe(false);
    expect(rejectedAsBadMessage('Telegram ответил 429')).toBe(false);
    expect(rejectedAsBadMessage('fetch failed')).toBe(false);
  });
});

describe('прогон сторожа: текст ошибки с «<» больше не блокирует тревогу', () => {
  it('в Telegram уходит экранированный текст с parse_mode HTML', async () => {
    everyCheckFailsWithHtmlError();
    const result = await runWatchdog();
    const [first] = sentBodies();
    expect(first?.parse_mode).toBe('HTML');
    expect(first.text).toContain('НЕ ПРОВЕРЕНО');
    expect(first.text).toContain('&lt;!DOCTYPE');
    expect(first.text).not.toContain('<!DOCTYPE');
    expect(result.delivery.status).toBe('delivered');
  });

  it('Telegram отверг разметку (400) — тот же текст уходит без неё, тревога доставлена', async () => {
    everyCheckFailsWithHtmlError();
    fetchMock.mockImplementation((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { parse_mode?: string };
      return Promise.resolve(body.parse_mode === 'HTML'
        ? { ok: false, status: 400, text: () => Promise.resolve('{"description":"Bad Request: can\'t parse entities"}') }
        : { ok: true, status: 200, text: () => Promise.resolve('') });
    });
    const result = await runWatchdog();
    const bodies = sentBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].parse_mode).toBeUndefined();
    expect(bodies[1].text).toContain('<!DOCTYPE');
    expect(result.delivery).toMatchObject({ status: 'delivered' });
    expect((result.delivery as { note?: string }).note).toContain('простым текстом');
  });

  it('Telegram не принял ни так, ни так — delivery: failed с причиной, повтор будет', async () => {
    oneUnconfirmedBooking(30);
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('{"description":"Bad Request"}') });
    const result = await runWatchdog();
    expect(sentBodies()).toHaveLength(2);
    expect(result.delivery.status).toBe('failed');
    // Отметка «отправлено» не ставится: следующий прогон обязан повторить.
    expect(memoryRememberMock).not.toHaveBeenCalled();
  });

  it('бот заблокирован (403) — простым текстом не повторяем, это не лечится', async () => {
    oneUnconfirmedBooking(30);
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('bot was blocked') });
    const result = await runWatchdog();
    expect(sentBodies()).toHaveLength(1);
    expect(result.delivery.status).toBe('failed');
  });
});

describe('«брони без подтверждения» не шлётся каждый час', () => {
  it('ключ повтора не зависит от возраста брони: 30 ч и 31 ч — один ключ', async () => {
    const keyFor = async (hours: number) => {
      memoryGetMock.mockClear();
      oneUnconfirmedBooking(hours);
      await runWatchdog();
      return memoryGetMock.mock.calls.map((c) => String(c[2])).find((k) => k.startsWith('unconfirmed_booking:'));
    };
    const a = await keyFor(30);
    const b = await keyFor(31);
    expect(a, 'ключа дебаунса нет — тревога считалась критической или не собралась').toBeTruthy();
    expect(b).toBe(a);
  });

  it('тот же алерт через час при записанной отметке — не отправляется', async () => {
    oneUnconfirmedBooking(31);
    // Отметки стоят у всего некритического: в подмене базы есть и вторая
    // стоячая тревога (миграции), она тут не предмет проверки.
    memoryGetMock.mockResolvedValue({ sent: true });
    const result = await runWatchdog();
    expect(result.alerts.map((a) => a.type)).toContain('unconfirmed_booking');
    expect(sentBodies()).toHaveLength(0);
    expect(result.delivery.status).toBe('debounced');
  });
});

describe('статус прогона: недоставка — отказ, а не успех', () => {
  const checksOk = { total: 28, failed: [] };
  it('всё проверено и доставлено — success', () => {
    expect(watchdogRunVerdict({ checks: checksOk, delivery: { status: 'delivered' } }))
      .toMatchObject({ status: 'success', ok: true, errorsCount: 0, skipReason: null });
  });
  it('тревога собрана и не доставлена — failed, причина названа', () => {
    const v = watchdogRunVerdict({ checks: checksOk, delivery: { status: 'failed', reason: 'Telegram ответил 403: blocked' } });
    expect(v).toMatchObject({ status: 'failed', ok: false, errorsCount: 1 });
    expect(v.errorMsg).toContain('тревога не доставлена в Telegram: Telegram ответил 403');
    expect(v.skipReason).toContain('undelivered');
  });
  it('часть проверок не выполнилась, тревога дошла — partial, как раньше', () => {
    const v = watchdogRunVerdict({ checks: { total: 28, failed: [{ check: 'checkStay', reason: 'x' }] }, delivery: { status: 'delivered' } });
    expect(v).toMatchObject({ status: 'partial', ok: false, errorsCount: 1, skipReason: 'unverified: checkStay' });
  });
  it('и проверки упали, и тревога не дошла — failed, названо оба', () => {
    const v = watchdogRunVerdict({ checks: { total: 28, failed: [{ check: 'checkStay', reason: 'x' }] }, delivery: { status: 'failed', reason: 'сеть' } });
    expect(v.status).toBe('failed');
    expect(v.errorsCount).toBe(2);
    expect(v.errorMsg).toContain('не доставлена');
    expect(v.errorMsg).toContain('checkStay');
  });
  it('нечего слать и «уже писали» — не отказ', () => {
    expect(watchdogRunVerdict({ checks: checksOk, delivery: { status: 'nothing_to_send' } }).status).toBe('success');
    expect(watchdogRunVerdict({ checks: checksOk, delivery: { status: 'debounced', suppressed: 3 } }).status).toBe('success');
  });
});

describe('вторая нога (шаг workflow) следит за сторожем', () => {
  const run = (over: Record<string, unknown> = {}) => JSON.stringify({
    success: true, alerts: [{ type: 'sos_abandoned', details: 'SOS, координаты: 53.02, 158.65' }],
    checks: { total: 28, failed: [] }, delivery: { status: 'delivered' }, ...over,
  });
  const skipped = (last_run: unknown) => JSON.stringify({ success: true, skipped: 'lease_held', agent_id: 'watchdog', last_run });

  it('обычный прогон — зелёный, в сводке числа, а не тексты тревог', () => {
    const v = watchdogStepVerdict(200, run());
    expect(v.exitCode).toBe(0);
    const out = v.lines.join('\n');
    expect(out).toContain('тревог 1');
    expect(out).not.toContain('координаты');
    expect(out).not.toContain('53.02');
  });

  it('тревога не доставлена — красный с причиной', () => {
    const v = watchdogStepVerdict(200, run({ success: false, delivery: { status: 'failed', reason: 'Telegram ответил 403: blocked' } }));
    expect(v.exitCode).toBe(1);
    expect(v.lines.join('\n')).toContain('::error::Сторож собрал тревогу, но до владельца она не дошла: Telegram ответил 403');
  });

  it('не выполнились проверки — предупреждение с именами, шаг зелёный', () => {
    const v = watchdogStepVerdict(200, run({ checks: { total: 28, failed: [{ check: 'checkStay', reason: 'x' }] } }));
    expect(v.exitCode).toBe(0);
    expect(v.lines.join('\n')).toContain('::warning::Не выполнились проверки сторожа: checkStay');
  });

  it('окно занято, последний прогон не доставил тревогу — красный', () => {
    const v = watchdogStepVerdict(200, skipped({ status: 'failed', age_min: 12, delivery: 'failed', reason: 'Telegram ответил 400' }));
    expect(v.exitCode).toBe(1);
    expect(v.lines.join('\n')).toContain('до владельца она не дошла (12 мин назад)');
  });

  it('окно занято, а записи о прогоне давно нет — красный: держатель мог упасть', () => {
    const v = watchdogStepVerdict(200, skipped({ status: 'success', age_min: LAST_RUN_STALE_MIN + 1, delivery: 'delivered', reason: null }));
    expect(v.exitCode).toBe(1);
    expect(v.lines.join('\n')).toContain('держатель окна мог упасть');
  });

  it('окно занято, последний прогон свежий и здоровый — SKIP, зелёный', () => {
    const v = watchdogStepVerdict(200, skipped({ status: 'success', age_min: 14, delivery: 'nothing_to_send', reason: null }));
    expect(v.exitCode).toBe(0);
    expect(v.lines.join('\n')).toContain('SKIP lease_held — последний прогон: success, 14 мин назад');
  });

  it('последний прогон не прочитан или его нет — предупреждение, не зелёная тишина', () => {
    for (const last of [{ unread: true }, { never: true }, undefined]) {
      const v = watchdogStepVerdict(200, skipped(last));
      expect(v.exitCode).toBe(0);
      expect(v.lines.join('\n')).toContain('::warning::');
    }
  });

  it('не 200 и неразобранное тело — красный', () => {
    expect(watchdogStepVerdict(500, '').exitCode).toBe(1);
    expect(watchdogStepVerdict(0, '').lines).toContain('FAIL 000');
    expect(watchdogStepVerdict(200, '<html>502</html>').exitCode).toBe(1);
  });

  it('тело ответа в публичный лог не печатается', () => {
    const yml = readFileSync(join(process.cwd(), '.github/workflows/cron-watchdog.yml'), 'utf8');
    const step = readFileSync(join(process.cwd(), 'scripts/watchdog-step.mjs'), 'utf8');
    expect(yml).not.toMatch(/cat\s+\/tmp\/[\w.-]*out\.json/);
    expect(step).not.toMatch(/console\.log\(\s*body\s*\)/);
  });
});
