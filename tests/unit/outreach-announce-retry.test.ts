/**
 * tests/unit/outreach-announce-retry.test.ts
 *
 * Оператор, о котором не удалось сообщить, не теряется навсегда.
 *
 * Находка Evo Judge 15.09: в `executeOperatorOutreach` INSERT, отправка в
 * Telegram и UPDATE шли подряд на каждом операторе. Отказ на чужом HTTP
 * оставлял строку в статусе 'found' — а дедуп следующего прогона
 * (`NOT EXISTS` по email/имени) такую строку исключает по построению. То
 * есть объявить её было уже НЕКОМУ: молча, без ошибки, без второй попытки.
 *
 * ПОЧЕМУ НЕ ТРАНЗАКЦИЯ. Отправленное сообщение откатом не возвращается, а
 * держать транзакцию поверх внешнего HTTP — держать блокировку на время
 * чужого таймаута. Лечит повторная попытка: объявление привязано к
 * СОСТОЯНИЮ строки ('found'), а не к «только что вставили», и застрявшее
 * подхватывает следующий прогон.
 *
 * Сторож держит связку целиком, а не половину: отдельную фазу объявления,
 * перепроверку статуса в UPDATE, три исхода отправки вместо двух и честный
 * `verification_passed` (§4.0).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const callAIFastMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => callAIFastMock(...args),
  isWaterfallErrorResponse: () => false,
}));

const SRC = readFileSync('lib/agents/execution/handlers/operator-outreach-executor.ts', 'utf8');

const TASK = {
  approval_id: '00000000-0000-0000-0000-000000000001',
  executor_agent_id: 'intelligence',
  action_type: 'operator_outreach',
  description: 'поиск операторов',
  context: {},
  due_date: '2026-09-15',
};

/** Ответы Telegram задаются тестом; RSS всегда отдаёт пустую ленту. */
function installFetch(telegramOk: boolean | (() => never)) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('sendMessage')) {
      if (typeof telegramOk === 'function') telegramOk();
      return { ok: telegramOk, status: telegramOk ? 200 : 502, text: async () => 'bad gateway' } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => '<rss></rss>' } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** Одна строка в очереди ждёт объявления; новых операторов лента не дала. */
function installPool(pending: Array<Record<string, unknown>>, markedRows: Array<{ id: string }>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  poolQueryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO outreach_queue')) return { rows: [], rowCount: 0 };
    if (sql.includes("WHERE status = 'found'")) return { rows: pending, rowCount: pending.length };
    if (sql.includes('UPDATE outreach_queue')) return { rows: markedRows, rowCount: markedRows.length };
    return { rows: [], rowCount: 0 };
  });
  return queries;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '42';
  callAIFastMock.mockResolvedValue('[]');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('объявление очереди — по состоянию строки, а не по факту вставки', () => {
  it('застрявшее с прошлых прогонов объявляется, хотя новых операторов нет', async () => {
    const queries = installPool(
      [{ id: 'aa-1', company_name: 'Камчатка Тур', email: 'a@b.ru', website: null, source: 'rata-news' }],
      [{ id: 'aa-1' }],
    );
    const { calls } = installFetch(true);

    const { executeOperatorOutreach } = await import('@/lib/agents/execution/handlers/operator-outreach-executor');
    const result = await executeOperatorOutreach(TASK);

    // Отбор шёл по статусу — значит прошлый прогон не заперт дедупом.
    const select = queries.find(q => q.sql.includes("WHERE status = 'found'"));
    expect(select, 'фазы объявления нет — застрявшая строка не подхватится').toBeTruthy();

    expect(calls.filter(u => u.includes('sendMessage')).length).toBeGreaterThanOrEqual(2); // оператор + итог
    expect(result.changes_made.join('\n')).toContain('Камчатка Тур');
    expect(result.verification_passed).toBe(true);
  });

  it('UPDATE перепроверяет статус — решение администратора не затирается', async () => {
    const queries = installPool(
      [{ id: 'aa-2', company_name: 'Вулкан Трэвел', email: null, website: null, source: 'tourprom' }],
      [{ id: 'aa-2' }],
    );
    installFetch(true);

    const { executeOperatorOutreach } = await import('@/lib/agents/execution/handlers/operator-outreach-executor');
    await executeOperatorOutreach(TASK);

    const update = queries.find(q => q.sql.includes('UPDATE outreach_queue'));
    expect(update).toBeTruthy();
    expect(update!.sql, 'без перепроверки UPDATE затрёт статус, выставленный из панели')
      .toContain("AND status = 'found'");
    expect(update!.sql, 'без RETURNING счётчик назовёт намерение, а не факт').toContain('RETURNING id');
  });

  it('статус сменился за время прогона — отметку не ставим и говорим об этом', async () => {
    installPool(
      [{ id: 'aa-3', company_name: 'Тихий Океан', email: null, website: null, source: 'rata-news' }],
      [], // UPDATE не нашёл строку в 'found' — её уже тронули
    );
    installFetch(true);

    const { executeOperatorOutreach } = await import('@/lib/agents/execution/handlers/operator-outreach-executor');
    const result = await executeOperatorOutreach(TASK);

    expect(result.changes_made.join('\n')).toContain('Статус "Тихий Океан" изменён за время прогона');
    expect(result.changes_made.join('\n')).toContain('объявлено 0 из 1 ожидавших');
  });
});

describe('отказ доставки — не тишина', () => {
  it('HTTP-отказ Telegram: строка остаётся в очереди, ошибка названа, проверка не пройдена', async () => {
    const queries = installPool(
      [{ id: 'bb-1', company_name: 'Сопка Тур', email: null, website: null, source: 'rata-news' }],
      [{ id: 'bb-1' }],
    );
    installFetch(false);

    const { executeOperatorOutreach } = await import('@/lib/agents/execution/handlers/operator-outreach-executor');
    const result = await executeOperatorOutreach(TASK);

    // Не дошло — значит 'contacted' ставить нельзя: иначе оператор числится
    // объявленным, а человек о нём не узнал никогда.
    expect(queries.some(q => q.sql.includes('UPDATE outreach_queue'))).toBe(false);
    expect(result.errors.join('\n')).toContain('Сопка Тур');
    expect(result.verification_passed, 'непроверенное не равно хорошему (§4.0)').toBe(false);
    expect(result.changes_made.join('\n')).toContain('Осталось необъявленных: 1');
  });

  it('сетевой отказ ловится и называется, а не роняет остальную очередь', async () => {
    installPool(
      [
        { id: 'cc-1', company_name: 'Первый', email: null, website: null, source: 'rata-news' },
        { id: 'cc-2', company_name: 'Второй', email: null, website: null, source: 'rata-news' },
      ],
      [{ id: 'cc-2' }],
    );
    installFetch(() => { throw new Error('ECONNRESET'); });

    const { executeOperatorOutreach } = await import('@/lib/agents/execution/handlers/operator-outreach-executor');
    const result = await executeOperatorOutreach(TASK);

    expect(result.errors.length).toBe(2); // оба оператора названы поимённо
    expect(result.errors.join('\n')).toContain('Первый');
    expect(result.errors.join('\n')).toContain('Второй');
    expect(result.verification_passed).toBe(false);
  });

  it('Telegram не настроен — это отдельное состояние, не «ошибка» и не успех', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    installPool(
      [{ id: 'dd-1', company_name: 'Без токена', email: null, website: null, source: 'rata-news' }],
      [],
    );
    installFetch(true);

    const { executeOperatorOutreach } = await import('@/lib/agents/execution/handlers/operator-outreach-executor');
    const result = await executeOperatorOutreach(TASK);

    expect(result.changes_made.join('\n')).toContain('объявлять некуда, очередь ждёт');
    expect(result.errors, 'ненастроенность — не отказ доставки').toEqual([]);
    expect(result.verification_passed, 'объявить не смогли — значит не проверено').toBe(false);
  });
});

describe('исходный код держит форму', () => {
  it('в цикле вставки нет отправки в Telegram — иначе фаза снова слипнется', () => {
    const at = SRC.indexOf('for (const op of operators)');
    const end = SRC.indexOf('} catch (rssErr)', at);
    const loop = SRC.slice(at, end > -1 ? end : at + 4000);
    expect(at).toBeGreaterThan(-1);
    expect(loop, 'объявление внутри цикла вставки возвращает потерю оператора')
      .not.toContain('sendOperatorToTelegram');
  });

  it('исход отправки — три состояния, а не boolean', () => {
    expect(SRC).toContain("reason: 'not_configured'");
    expect(SRC).toContain("reason: 'failed'");
    expect(SRC).toMatch(/Promise<SendOutcome>/);
  });

  it('verification_passed считается, а не проставляется константой', () => {
    expect(SRC).not.toMatch(/verification_passed:\s*true,/);
    expect(SRC).toMatch(/verification_passed:\s*notAnnouncedCount === 0 && errors\.length === 0/);
  });

  it('отказ доставки уходит в лог через общий logSwallowedFailure', () => {
    expect(SRC).toContain("logSwallowedFailure('operator-outreach'");
  });
});
