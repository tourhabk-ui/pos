/**
 * tests/unit/watchdog-alert-debounce.test.ts
 *
 * Владелец на живом скрине: «Watchdog — требует внимания» с ДОСЛОВНО тем же
 * текстом про Intelligence Monitor три раза за час (14:04, 14:46, 15:08) —
 * крон идёт каждые 30 мин и шлёт одно и то же, пока условие не исчезнет.
 * Та же болезнь, что была у push-алертов туристам (road_closure с нескольких
 * источников): рупор, который не может замолчать, приучает не читать.
 *
 * Правка (06.09): ВНИМАНИЕ-алерты дебаунсятся по (тип + содержание) на
 * WATCHDOG_ALERT_DEBOUNCE_HOURS. КРИТ — намеренно НЕ дебаунсится (решено
 * раньше, комментарий у checkUndeliveredSafetyPush): настоящий КРИТ обязан
 * долбить, пока не почини́ли.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
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

import { runWatchdog, WATCHDOG_ALERT_DEBOUNCE_HOURS } from '@/lib/agents/watchdog';

const MIGRATIONS = 'FROM _migrations';
const UNDELIVERED = 'push_sent_at IS NULL';
const SUBS = 'FROM push_subscriptions';

/** Ни одна миграция не отмечена применённой — надёжный, стабильный ВНИМАНИЕ-алерт. */
function baseQueries(opts: { undelivered?: boolean; subs?: number } = {}) {
  poolQueryMock.mockImplementation((sql: string) => {
    const q = String(sql);
    if (q.includes(MIGRATIONS)) return Promise.resolve({ rows: [] });
    if (q.includes(UNDELIVERED)) {
      return opts.undelivered
        ? Promise.resolve({ rows: [{ count: '3', oldest_title: 'Цунами: угроза побережью' }] })
        : Promise.resolve({ rows: [{ count: '0', oldest_title: null }] });
    }
    if (q.includes(SUBS)) return Promise.resolve({ rows: [{ n: String(opts.subs ?? 0) }] });
    if (q.includes('agent_run_history')) {
      return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

let errSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  poolQueryMock.mockReset();
  memoryGetMock.mockReset();
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

function sentText(): string {
  const call = fetchMock.mock.calls[0];
  const body = call ? JSON.parse((call[1] as { body: string }).body) as { text: string } : null;
  return body?.text ?? '';
}

describe('ВНИМАНИЕ-алерт дебаунсится', () => {
  it('первый раз — уходит в Telegram и отмечается в памяти', async () => {
    baseQueries();
    memoryGetMock.mockResolvedValue(null); // ещё не отправляли
    const result = await runWatchdog();

    expect(result.alerts.some(a => a.type === 'migration_unapplied')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('ВНИМАНИЕ:');
    expect(result.delivery.status).toBe('delivered');
    // Отмечено ПОСЛЕ удачной отправки — remember вызван.
    expect(memoryRememberMock).toHaveBeenCalled();
    const rememberedType = (memoryRememberMock.mock.calls[0]?.[0] as { value?: { type?: string } }).value?.type;
    expect(rememberedType).toBe('migration_unapplied');
  });

  it('повтор в пределах окна — Telegram не получает новое сообщение, delivery: debounced', async () => {
    baseQueries();
    memoryGetMock.mockResolvedValue({ value: { sent_at: new Date().toISOString() } }); // уже писали
    const result = await runWatchdog();

    // Нарушение по-прежнему ЧЕСТНО в результате — дебаунс не подделывает "чисто".
    expect(result.alerts.some(a => a.type === 'migration_unapplied')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.delivery).toEqual({ status: 'debounced', suppressed: 1 });
    // Раз ничего не отправляли — отмечать заново нечего.
    expect(memoryRememberMock).not.toHaveBeenCalled();
  });

  it('дебаунс на 12 часов — тот же порядок, что у мёртвых источников разведки', () => {
    expect(WATCHDOG_ALERT_DEBOUNCE_HOURS).toBe(12);
  });
});

describe('КРИТ не дебаунсится никогда', () => {
  it('критичный алерт уходит, даже если "уже отправляли" — agentMemory для него не спрашивается', async () => {
    baseQueries({ undelivered: true, subs: 42 }); // push_undelivered: critical=true
    memoryGetMock.mockResolvedValue({ value: { sent_at: new Date().toISOString() } }); // всё "уже видели"
    const result = await runWatchdog();

    const critAlert = result.alerts.find(a => a.type === 'push_undelivered');
    expect(critAlert?.critical).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('КРИТ:');
    expect(result.delivery.status).toBe('delivered');
  });

  it('смешанный прогон: КРИТ проходит, ВНИМАНИЕ подавлен и назван числом', async () => {
    baseQueries({ undelivered: true, subs: 42 });
    // get() зовётся только для НЕ-критичных — вернём "уже видели" всем, чтобы
    // проверить, что КРИТ это не остановит, а ВНИМАНИЕ — остановит.
    memoryGetMock.mockResolvedValue({ value: { sent_at: new Date().toISOString() } });
    const result = await runWatchdog();

    const text = sentText();
    expect(text).toContain('КРИТ:');
    expect(text).not.toContain('ВНИМАНИЕ:');
    expect(text).toMatch(/и ещё \d+ без изменений/);
  });
});

describe('ключ дебаунса учитывает содержание, не только тип', () => {
  it('agentMemory.get зовётся с ключом, содержащим тип алерта', async () => {
    baseQueries();
    memoryGetMock.mockResolvedValue(null);
    await runWatchdog();

    const call = memoryGetMock.mock.calls.find(c => String(c[2]).startsWith('migration_unapplied:'));
    expect(call, 'ключ дебаунса не содержит тип алерта').toBeTruthy();
    expect(call?.[0]).toBe('watchdog');
    expect(call?.[1]).toBe('alert_sent');
  });
});
