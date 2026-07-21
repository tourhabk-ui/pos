/**
 * tests/unit/editor-error-observability.test.ts
 *
 * Прод-инцидент «SMOKE WARN: Editor — обработано 30, улучшено 0 (ошибок: 30)»:
 * причина была недиагностируема, потому что EditorResult нёс только число errors,
 * а catch'и были пустыми. Эти тесты фиксируют контракт наблюдаемости:
 * runEditor различает generation_failed / db_update_failed и отдаёт
 * error_samples с конкретными причинами — они уходят в Telegram-алерт смоук-теста.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEditor, type RouteRow } from '@/lib/agents/editor';

// ── Моки провайдеров ─────────────────────────────────────────────────────────
const callAIFastMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();

vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => callAIFastMock(...args),
}));

// ── Мок пула БД ──────────────────────────────────────────────────────────────
const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();

vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

const ROUTE: RouteRow = {
  id: '00000000-0000-0000-0000-000000000001',
  title: 'Вулкан Тестовый',
  description: null,
  category: 'vulkani',
};

const LONG_TEXT = 'Содержательное описание вулкана. '.repeat(15); // ~495 симв. >= 100

function mockDb(opts: { routes: RouteRow[]; updateError?: Error }) {
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('SELECT id, title')) return Promise.resolve({ rows: opts.routes });
    if (sql.includes('UPDATE agent_route_knowledge')) {
      if (opts.updateError) return Promise.reject(opts.updateError);
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ cnt: '5' }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN; // tgSend — no-op в тестах
  delete process.env.TELEGRAM_CHAT_ID;
});

// ── runEditor: раздельные счётчики и причины ─────────────────────────────────

describe('runEditor: наблюдаемость ошибок', () => {
  it('генерация вернула null → generation_failed + sample с причиной', async () => {
    mockDb({ routes: [ROUTE] });
    callAIFastMock.mockResolvedValue(null);

    const result = await runEditor();

    expect(result.processed).toBe(1);
    expect(result.improved).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.generation_failed).toBe(1);
    expect(result.db_update_failed).toBe(0);
    expect(result.error_samples).toHaveLength(1);
    expect(result.error_samples[0]).toContain('пустой ответ');
  });

  it('apology-заглушка waterfall (все провайдеры отказали) → generation_failed с внятной причиной', async () => {
    mockDb({ routes: [ROUTE] });
    // Ровно то, что возвращает callAIFast при отказе ВСЕХ fast-провайдеров
    callAIFastMock.mockResolvedValue('Сервис временно недоступен.');

    const result = await runEditor();

    expect(result.generation_failed).toBe(1);
    expect(result.error_samples[0]).toContain('короткий ответ 27 симв.');
    expect(result.error_samples[0]).toContain('fast-провайдеры отказали');
  });

  it('UPDATE бросает → db_update_failed + sample с названием маршрута и сообщением БД', async () => {
    mockDb({ routes: [ROUTE], updateError: new Error('column ot.duration_days does not exist') });
    callAIFastMock.mockResolvedValue(LONG_TEXT);

    const result = await runEditor();

    expect(result.generation_failed).toBe(0);
    expect(result.db_update_failed).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.error_samples[0]).toContain('db_update');
    expect(result.error_samples[0]).toContain('Вулкан Тестовый');
    expect(result.error_samples[0]).toContain('column ot.duration_days does not exist');
  });

  it('SELECT очереди бросает → errors=1 + sample db_select', async () => {
    poolQueryMock.mockRejectedValue(new Error('connection refused'));

    const result = await runEditor();

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.error_samples[0]).toContain('db_select');
    expect(result.error_samples[0]).toContain('connection refused');
  });

  it('успешный путь не регрессировал: improved++, samples пусты', async () => {
    mockDb({ routes: [ROUTE] });
    callAIFastMock.mockResolvedValue(LONG_TEXT);

    const result = await runEditor();

    expect(result.processed).toBe(1);
    expect(result.improved).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.generation_failed).toBe(0);
    expect(result.db_update_failed).toBe(0);
    expect(result.error_samples).toEqual([]);
    expect(result.improved_ids).toEqual([ROUTE.id]);
    expect(result.improved_titles).toEqual([ROUTE.title]);
  });

  it('успешный путь: stopped_early = false (бюджет не исчерпан)', async () => {
    mockDb({ routes: [ROUTE] });
    callAIFastMock.mockResolvedValue(LONG_TEXT);

    const result = await runEditor();

    expect(result.stopped_early).toBe(false);
  });

  it('бюджет времени исчерпан → stopped_early, остаток не обрабатывается (страховка от curl --max-time 300)', async () => {
    // Прод-инцидент 2026-07-21: 30 последовательных AI-вызовов не уложились
    // в 300с curl-таймаута крона → exit 28, весь прогон засчитан провалом.
    // Теперь цикл останавливается по бюджету и возвращает частичный результат.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const routes = Array.from({ length: 5 }, (_, i) => ({ ...ROUTE, id: `00000000-0000-0000-0000-00000000000${i + 1}` }));
      mockDb({ routes });
      // Первый маршрут обрабатывается, но «съедает» больше бюджета — второй уже не начнётся.
      callAIFastMock.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 220_000); // перескок за TIME_BUDGET_MS (210с)
        return LONG_TEXT;
      });

      const result = await runEditor();

      expect(result.stopped_early).toBe(true);
      expect(result.processed).toBe(1);          // только первый — остальные обрезаны бюджетом
      expect(result.improved).toBe(1);           // уже записанное сохранено
      expect(callAIFastMock).toHaveBeenCalledTimes(1);
      expect(result.error_samples.some((s) => s.includes('бюджет времени'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('error_samples дедуплицируются и ограничены 5', async () => {
    const routes = Array.from({ length: 8 }, (_, i) => ({ ...ROUTE, id: `00000000-0000-0000-0000-00000000000${i + 1}` }));
    mockDb({ routes });
    callAIFastMock.mockResolvedValue(null); // одна и та же причина у всех 8

    const result = await runEditor();

    expect(result.errors).toBe(8);
    expect(result.error_samples).toHaveLength(1); // дедуп: причина одинаковая
  });
});

// Тесты варианта B (Fugu) удалены вместе с A/B экспериментом: он завершился
// ничьёй (оба 100%), выбран waterfall как бесплатный — см. комментарий в editor.ts.
