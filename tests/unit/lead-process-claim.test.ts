/**
 * Разбор заявки моделью берёт заявку захватом в самой записи (#3433 п. 3).
 *
 * `leadProcessor.process` зовут шесть мест: крон, кнопка «Обработать AI» в MAX
 * и Telegram, создание заявки, два роута. Проверка «уже обрабатывается» стояла
 * ДО записи статуса: двойное нажатие кнопки или нажатие во время прогона крона
 * — оба вызова видели `new`, оба шли к модели и оба писали предложение.
 *
 * Вызовом настоящего `process` с базой в памяти: запись статуса исполняется
 * по смыслу условия LEAD_AI_START_SQL (на настоящем PostgreSQL его держит
 * tests/integration/request-chat.pg.test.ts), чтение заявки придержано, чтобы
 * оба вызова прочли `new` до записи.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  status: 'new' as string,
  readers: [] as Array<() => void>,
  holdReads: 0,
  ai: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sqlIn: unknown, params: unknown[] = []) => {
      const sql = String(sqlIn).replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT id, operator_id::text AS operator_id')) {
        // Придержать чтение, пока его не сделают оба вызова.
        if (h.holdReads > 0) {
          h.holdReads -= 1;
          await new Promise<void>((resolve) => { h.readers.push(resolve); if (h.holdReads === 0) h.readers.splice(0).forEach((r) => r()); });
        }
        return { rows: [{ id: params[0], operator_id: null, name: 'Тест', phone: '+70000000000', email: null, comment: 'Хочу на вулкан', route_title: null, source_data: {}, group_size: null, budget_rub: null, desired_dates: null, status: h.status }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE leads SET status = 'ai_processing'")) {
        // Условие записи исполняется так, как написано в запросе: «не отменена»
        // ($2) и — только если оно есть в тексте — «не занята» (NOT IN (...)).
        const notIn = /status NOT IN \(([^)]*)\)/.exec(sql)?.[1].match(/'([a-z_]+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
        if (h.status === params[1] || notIn.includes(h.status)) return { rows: [], rowCount: 0 };
        h.status = 'ai_processing';
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT status FROM leads')) return { rows: [{ status: h.status }], rowCount: 1 };
      if (sql.startsWith("UPDATE leads SET status = 'new'") && h.status === 'ai_processing') {
        h.status = 'new';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
}));
vi.mock('@/lib/ai/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/providers')>()),
  callAIFast: (...a: unknown[]) => h.ai(...a),
}));
vi.mock('@/lib/crm/events', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/events')>()),
  recordSourceEventQuietly: vi.fn(async () => undefined),
}));

const { leadProcessor, LEAD_AI_START_SQL, LEAD_AI_BUSY_STATUSES } = await import('@/lib/services/operators/lead-processor.service');
const { LeadCancelledByClientError } = await import('@/lib/leads/client-cancelled');

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';

beforeEach(() => {
  h.status = 'new';
  h.readers = [];
  h.holdReads = 0;
  h.ai.mockReset();
  // Модель отказывает — разбор уходит в откат; здесь важно, сколько раз до неё дошли.
  h.ai.mockRejectedValue(new Error('модель в тесте недоступна'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('два одновременных разбора одной заявки', () => {
  it('оба прочли «new» — заявку берёт один, второй отказ «уже обрабатывается», модель зовётся одним', async () => {
    h.holdReads = 2;
    const [a, b] = await Promise.allSettled([leadProcessor.process(LEAD), leadProcessor.process(LEAD)]);
    const reasons = [a, b].map((r) => (r.status === 'rejected' ? String((r.reason as Error).message) : 'ok'));
    expect(reasons).toContain('Лид уже обрабатывается');
    // Один разбор дошёл до модели (и упал на ней), второй — нет.
    const callsPerRun = h.ai.mock.calls.length;
    expect(callsPerRun).toBeGreaterThan(0);
    h.ai.mockClear();
    h.status = 'new';
    await leadProcessor.process(LEAD).catch(() => undefined);
    expect(h.ai.mock.calls.length).toBe(callsPerRun);
  });

  it('отменённая клиентом — свой отказ, модель не зовётся', async () => {
    h.status = 'cancelled';
    await expect(leadProcessor.process(LEAD)).rejects.toBeInstanceOf(LeadCancelledByClientError);
    expect(h.ai).not.toHaveBeenCalled();
  });
});

describe('условие захвата — в самой записи', () => {
  it('LEAD_AI_START_SQL не берёт занятую заявку и заявку с предложением', () => {
    expect([...LEAD_AI_BUSY_STATUSES]).toEqual(['ai_processing', 'proposal_sent', 'converted']);
    for (const st of LEAD_AI_BUSY_STATUSES) expect(LEAD_AI_START_SQL).toContain(`'${st}'`);
    expect(LEAD_AI_START_SQL).toMatch(/WHERE id = \$1 AND status <> \$2\s+AND status NOT IN/);
  });
});
