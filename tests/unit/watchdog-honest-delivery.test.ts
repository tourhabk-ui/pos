/**
 * Сторож не имеет права ни молчать, ни выдумывать.
 *
 * Аудит 30.08 нашёл в Watchdog ту же болезнь, которую он поставлен ловить —
 * §4.0, исход «не смог», схлопнутый в «хорошо». Два места, оба в контуре, от
 * которого зависит жизнь:
 *
 * W-2. `tgSend` заканчивался `catch { // Silent fail }`, а ответ Telegram не
 * читался вовсе. Тревога могла собраться и не уйти: ни строки в логе, ни
 * отметки в результате, прогон зелёный. Сторож без исправного рупора
 * неотличим от сторожа, которому не о чем доложить.
 *
 * W-3. В `checkUndeliveredSafetyPush` переменная `subs` инициализировалась
 * нулём, и пустой `catch` её не трогал — значит ОТКАЗ запроса становился
 * измеренным нулём. Дальше ветка «канал пуст» объявляла фактом «подписчиков
 * 0, доставлять некому» и этим ПОНИЖАЛА КРИТ о непредупреждённых туристах до
 * обычного предупреждения. Выдуманное число гасило тревогу о безопасности.
 *
 * Проверяется поведением на моках пула и fetch — тем же приёмом, что
 * watchdog-stay.test.ts.
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

import { runWatchdog } from '@/lib/agents/watchdog';

const UNDELIVERED = 'push_sent_at IS NULL';
const SUBS = 'FROM push_subscriptions';

/** Недоставленные опасные алерты есть; поведение счётчика подписок задаётся. */
function routeQueries(subs: 'fails' | number) {
  poolQueryMock.mockImplementation((sql: string) => {
    const q = String(sql);
    if (q.includes(UNDELIVERED)) {
      return Promise.resolve({ rows: [{ count: '3', oldest_title: 'Цунами: угроза побережью' }] });
    }
    if (q.includes(SUBS)) {
      return subs === 'fails'
        ? Promise.reject(new Error('relation "push_subscriptions" does not exist'))
        : Promise.resolve({ rows: [{ n: String(subs) }] });
    }
    if (q.includes('agent_run_history')) {
      return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  poolQueryMock.mockReset();
  process.env.NEXT_PUBLIC_VAPID_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('W-3: несосчитанное не выдаётся за ноль', () => {
  it('отказ счётчика подписок НЕ гасит КРИТ о непредупреждённых туристах', async () => {
    routeQueries('fails');
    const result = await runWatchdog();
    const alert = result.alerts.find(a => a.type === 'push_undelivered');
    expect(alert, 'алерт о недоставке пропал вовсе').toBeTruthy();
    expect(alert!.critical, 'выдуманный ноль понижал критичность — это и был дефект').toBe(true);
  });

  it('при отказе счётчика причина названа неустановленной, а не «подписчиков 0»', async () => {
    routeQueries('fails');
    const result = await runWatchdog();
    const alert = result.alerts.find(a => a.type === 'push_undelivered')!;
    expect(alert.details).toContain('не установлена');
    expect(alert.details, 'ноль не был измерен — утверждать его нельзя')
      .not.toContain('подписчиков 0');
  });

  it('отказ счётчика не молчит: причина уходит в лог (§4.0)', async () => {
    routeQueries('fails');
    await runWatchdog();
    const logged = errSpy.mock.calls.some(c => String(c[0]).includes('push_subscriptions'));
    expect(logged, 'пустой catch превращает поломку в «данных нет»').toBe(true);
  });

  it('ИЗМЕРЕННЫЙ ноль — алерта нет, факт в логе (решение владельца 05.09)', async () => {
    // Пустой канал это один стоячий факт о воронке, а не N критов о недоставке.
    // Ноль ИЗМЕРЕН — потому и молчим; неизмеренный (тест выше) остаётся КРИТом.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    routeQueries(0);
    const result = await runWatchdog();
    expect(result.alerts.find(a => a.type === 'push_undelivered')).toBeUndefined();
    expect(infoSpy.mock.calls.some(c => String(c[0]).includes('Push-канал пуст'))).toBe(true);
    infoSpy.mockRestore();
  });

  it('подписчики есть, доставки нет — КРИТ с их числом', async () => {
    routeQueries(42);
    const result = await runWatchdog();
    const alert = result.alerts.find(a => a.type === 'push_undelivered')!;
    expect(alert.critical).toBe(true);
    expect(alert.details).toContain('подписок 42');
  });
});

describe('W-1: «не смог проверить» — не «нарушений нет»', () => {
  /** Всё падает: и проверки, и всё остальное. Ровно случай «БД недоступна». */
  function everythingFails() {
    poolQueryMock.mockImplementation(() => Promise.reject(new Error('connection refused')));
  }

  it('отказ ВСЕХ проверок не выглядит как чистый прогон', async () => {
    everythingFails();
    const result = await runWatchdog();
    expect(result.alerts, 'нарушений не нашли — потому что не смогли искать').toHaveLength(0);
    expect(result.checks.failed.length, 'ни один отказ не попал в перепись').toBeGreaterThan(0);
    expect(result.checks.total).toBeGreaterThan(5);
  });

  it('отказавшие проверки названы поимённо и с причиной', async () => {
    everythingFails();
    const result = await runWatchdog();
    const one = result.checks.failed[0];
    expect(one.check).toMatch(/^check\w+/);
    expect(one.reason).toContain('connection refused');
  });

  it('при отказах владельцу пишут, хотя нарушений ноль', async () => {
    // Главное следствие дефекта: alerts пуст → Telegram молчал → прогон
    // зелёный. Молчание при непроверенном и есть выдача «не знаю» за «хорошо».
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.TELEGRAM_CHAT_ID = 'c';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', fetchMock);
    everythingFails();
    const result = await runWatchdog();
    expect(result.alerts).toHaveLength(0);
    expect(result.delivery.status, 'при отказах сообщение обязано уйти').toBe('delivered');
    const body = String((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toContain('НЕ ПРОВЕРЕНО');
    expect(body, 'сообщение обязано сказать, что это НЕ «нарушений нет»')
      .toContain('Это не «нарушений нет»');
    expect(body, 'проверки названы поимённо — чинят конкретную').toContain('checkUnconfirmedBookings');
  });

  it('чистый прогон переписи не портит: failed пуст', async () => {
    const applied = readdirSync(join(process.cwd(), 'migrations'))
      .filter(f => f.endsWith('.sql'))
      .map(name => ({ name }));
    poolQueryMock.mockImplementation((sql: string) => {
      const q = String(sql);
      if (q.includes('FROM _migrations')) return Promise.resolve({ rows: applied });
      if (q.includes('agent_run_history')) {
        return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const result = await runWatchdog();
    expect(result.checks.failed).toEqual([]);
    expect(result.alerts).toHaveLength(0);
  });
});

describe('W-2: судьба тревоги названа, а не умолчана', () => {
  it('канал не настроен — это недоставка, а не отсутствие нарушений', async () => {
    routeQueries(42);
    const result = await runWatchdog();
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.delivery.status).toBe('failed');
    if (result.delivery.status === 'failed') {
      expect(result.delivery.reason).toContain('TELEGRAM');
    }
  });

  it('Telegram ответил отказом — исход failed с кодом, а не тихий успех', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.TELEGRAM_CHAT_ID = 'c';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"description":"bot was blocked by the user"}'),
    }));
    routeQueries(42);
    const result = await runWatchdog();
    expect(result.delivery.status).toBe('failed');
    if (result.delivery.status === 'failed') {
      expect(result.delivery.reason).toContain('403');
    }
  });

  it('сетевой отказ тоже назван и не роняет прогон', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.TELEGRAM_CHAT_ID = 'c';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    routeQueries(42);
    const result = await runWatchdog();
    expect(result.delivery.status).toBe('failed');
    if (result.delivery.status === 'failed') {
      expect(result.delivery.reason).toContain('ECONNRESET');
    }
    // Крон не должен падать из-за Telegram — проверки отработали.
    expect(result.alerts.length).toBeGreaterThan(0);
  });

  it('успешная отправка — delivered', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.TELEGRAM_CHAT_ID = 'c';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('') }));
    routeQueries(42);
    const result = await runWatchdog();
    expect(result.delivery.status).toBe('delivered');
  });

  it('нарушений не было — nothing_to_send, и это НЕ «доставлено»', async () => {
    // Третий исход: отсутствие тревог и успешная доставка — разные факты.
    //
    // Все миграции объявляем применёнными: иначе checkUnappliedMigrations
    // законно поднимет алерт (он читает каталог migrations/ с диска), и
    // сценарий «тревог нет» не соберётся.
    const applied = readdirSync(join(process.cwd(), 'migrations'))
      .filter(f => f.endsWith('.sql'))
      .map(name => ({ name }));
    poolQueryMock.mockImplementation((sql: string) => {
      const q = String(sql);
      if (q.includes('FROM _migrations')) return Promise.resolve({ rows: applied });
      if (q.includes('agent_run_history')) {
        return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const result = await runWatchdog();
    expect(result.alerts, `неожиданные алерты: ${result.alerts.map(a => a.type).join(', ')}`).toHaveLength(0);
    expect(result.delivery.status).toBe('nothing_to_send');
  });
});
