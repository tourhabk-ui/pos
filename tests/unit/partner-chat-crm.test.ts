/**
 * Сторож помощника партнёра в его чате (CRM #2325, шаг 1д).
 *
 * Держит:
 *  - партнёр по чату — любой из шести ролей CRM; агент — только одобренный
 *    (то же правило, что у кабинета); роль вне CRM — помощник без инструментов;
 *  - «не смогли проверить» — свой исход с SQLSTATE в логе, а не «не партнёр»;
 *  - инструменты — только CRM, партнёр в них — из привязанного чата, запись
 *    подписана Кузьмичом;
 *  - записи сделаны, а модель не дошла до ответа — партнёр узнаёт, что
 *    записано, а не «не могу ответить» (иначе попросит снова, и будет дубль);
 *  - без инструментов помощник о клиентах ничего не утверждает;
 *  - в промпт оператора бронь идёт номером, без имени туриста.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const query = vi.fn();
const callToolsWaterfall = vi.fn();
const callAIWaterfallOrNull = vi.fn();
const saveMsg = vi.fn(async () => undefined);
const getHistory = vi.fn(async () => [{ role: 'user', content: 'кто ждёт ответа?' }]);
const executeCrmTool = vi.fn();

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/ai/providers', () => ({
  callToolsWaterfall: (...a: unknown[]) => callToolsWaterfall(...a),
  callAIWaterfallOrNull: (...a: unknown[]) => callAIWaterfallOrNull(...a),
}));
vi.mock('@/lib/kuzmich/core', () => ({
  saveMsg: (...a: unknown[]) => saveMsg(...(a as [])),
  getHistory: (...a: unknown[]) => getHistory(...(a as [])),
}));
vi.mock('@/lib/crm/tools', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/tools')>()),
  executeCrmTool: (...a: unknown[]) => executeCrmTool(...a),
}));

const chat = await import('@/lib/kuzmich/operator-chat');

const NOW = Date.parse('2026-10-10T00:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'p-1', name: 'Вулкан-Тур', category: 'guide', user_id: 'u-1', profile_status: 'approved', ...over,
});

beforeEach(() => {
  for (const m of [query, callToolsWaterfall, callAIWaterfallOrNull, saveMsg, executeCrmTool]) m.mockReset();
  getHistory.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('кто партнёр по чату', () => {
  it('найден по колонке своего канала; категория CRM — из шести ролей', async () => {
    query.mockResolvedValueOnce({ rows: [row()] });
    const r = await chat.findPartnerByChat('max', 777);
    expect(r).toEqual({ outcome: 'found', partner: { partnerId: 'p-1', partnerName: 'Вулкан-Тур', category: 'guide', crmCategory: 'guide', userId: 'u-1' } });
    expect(query.mock.calls[0][0]).toMatch(/WHERE max_chat_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual([777]);

    query.mockResolvedValueOnce({ rows: [row()] });
    await chat.findPartnerByChat('telegram', 5);
    expect(query.mock.calls[1][0]).toMatch(/WHERE telegram_chat_id = \$1/);
  });

  it('агент без одобрения и роль вне CRM — партнёр, но без инструментов CRM', async () => {
    query.mockResolvedValueOnce({ rows: [row({ category: 'agent', profile_status: 'pending' })] });
    expect(await chat.findPartnerByChat('telegram', 1)).toMatchObject({ partner: { crmCategory: null } });
    query.mockResolvedValueOnce({ rows: [row({ category: 'souvenir' })] });
    expect(await chat.findPartnerByChat('telegram', 1)).toMatchObject({ partner: { crmCategory: null } });
    query.mockResolvedValueOnce({ rows: [row({ category: 'agent', profile_status: 'approved' })] });
    expect(await chat.findPartnerByChat('telegram', 1)).toMatchObject({ partner: { crmCategory: 'agent' } });
  });

  it('нет строки — не партнёр; база не ответила — «не смогли проверить» с SQLSTATE', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await chat.findPartnerByChat('telegram', 1)).toEqual({ outcome: 'none' });
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '08006' }));
    expect(await chat.findPartnerByChat('telegram', 1)).toEqual({ outcome: 'unavailable' });
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/SQLSTATE 08006/);
  });

  it('пустое условие на статус снято: «blocked» нет в CHECK, оно не отсекало никого', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await chat.findPartnerByChat('telegram', 1);
    expect(query.mock.calls[0][0]).not.toMatch(/\bstatus\b\s*!=/);
  });

  it('в файле помощника нет имени туриста', () => {
    expect(readFileSync('lib/kuzmich/operator-chat.ts', 'utf8')).not.toMatch(/tourist_(name|email|phone)/);
  });
});

describe('ответ партнёру', () => {
  const guide = { partnerId: 'p-1', partnerName: 'Гид Иван', category: 'guide', crmCategory: 'guide' as const, userId: 'u-1' };
  const reply = vi.fn(async () => undefined);
  beforeEach(() => reply.mockReset());

  it('инструменты — только CRM; партнёр в них — из чата; запись от имени Кузьмича', async () => {
    callToolsWaterfall
      .mockResolvedValueOnce({ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'crm_find_contact', arguments: '{"query":"Анна","partner_id":"чужой"}' } }] })
      .mockResolvedValueOnce({ content: 'Нашёл: Анна П.', tool_calls: null });
    executeCrmTool.mockResolvedValue({ ok: true, data: { total: 1 } });

    await chat.processPartnerMessage({ chatId: 9, text: 'найди Анну', fromName: null, partner: guide, reply, nowMs: NOW });

    const tools = callToolsWaterfall.mock.calls[0][1] as Array<{ function: { name: string } }>;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.function.name).toMatch(/^crm_/);
    expect(executeCrmTool).toHaveBeenCalledWith(
      'crm_find_contact',
      { query: 'Анна', partner_id: 'чужой' },
      expect.objectContaining({ partnerId: 'p-1', category: 'guide', userId: 'u-1', actor: 'kuzmich', canWrite: true }),
    );
    // Вывод инструмента — обёрнутым как недоверенный.
    const second = callToolsWaterfall.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(second.find((m) => m.role === 'tool')?.content).toMatch(/trust="untrusted"/);
    const system = second[0].content;
    expect(system).toMatch(/Сегодня 2026-10-10 по Камчатке/);
    expect(system).toMatch(/только то, что вернули инструменты crm_\*/);
    expect(reply).toHaveBeenCalledWith(9, 'Нашёл: Анна П.');
    expect(callAIWaterfallOrNull).not.toHaveBeenCalled();
  });

  it('записи сделаны, модель не дошла до ответа — партнёр узнаёт, что записано', async () => {
    callToolsWaterfall
      .mockResolvedValueOnce({ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'crm_add_task', arguments: '{"title":"Перезвонить","due":"2026-10-11"}' } }] })
      .mockResolvedValueOnce(null);
    executeCrmTool.mockResolvedValue({ ok: true, data: { created: true } });

    await chat.processPartnerMessage({ chatId: 9, text: 'напомни перезвонить завтра', fromName: null, partner: guide, reply, nowMs: NOW });

    expect(reply.mock.calls[0][1]).toMatch(/^Записал: задача «Перезвонить» со сроком 2026-10-11/);
    expect(callAIWaterfallOrNull).not.toHaveBeenCalled();
  });

  it('инструменты не ответили, записей нет — ответ без них, и о CRM он ничего не утверждает', async () => {
    callToolsWaterfall.mockResolvedValueOnce(null);
    callAIWaterfallOrNull.mockResolvedValueOnce('Сейчас не вижу данных CRM.');
    await chat.processPartnerMessage({ chatId: 9, text: 'кто ждёт?', fromName: null, partner: guide, reply, nowMs: NOW });
    const system = (callAIWaterfallOrNull.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).toMatch(/Данные CRM в этом ответе недоступны/);
    expect(reply).toHaveBeenCalledWith(9, 'Сейчас не вижу данных CRM.');
  });

  it('роль вне CRM — без инструментов; все провайдеры молчат — свой текст, а не заглушка', async () => {
    callAIWaterfallOrNull.mockResolvedValueOnce(null);
    await chat.processPartnerMessage({
      chatId: 9, text: 'привет', fromName: null, reply, nowMs: NOW,
      partner: { ...guide, category: 'souvenir', crmCategory: null },
    });
    expect(callToolsWaterfall).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(9, 'Не могу ответить прямо сейчас. Попробуй ещё раз.');
  });

  it('оператору бронь в промпте — номером, без имени туриста', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours\s+WHERE/.test(sql)) return { rows: [] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ cnt: '1' }] };
      return { rows: [{ id: '42', booking_date: '2026-10-20', participants: 2, final_price: 30000, booking_status: 'new' }] };
    });
    callToolsWaterfall.mockResolvedValueOnce({ content: 'Одна бронь.', tool_calls: null });
    await chat.processPartnerMessage({
      chatId: 9, text: 'брони?', fromName: null, reply, nowMs: NOW,
      partner: { ...guide, category: 'operator', crmCategory: 'operator' },
    });
    const system = (callToolsWaterfall.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).toMatch(/бронь №42, 2 чел/);
    const bookingsSql = query.mock.calls.map((c) => c[0] as string).find((s) => /ob\.participants/.test(s)) ?? '';
    expect(bookingsSql).not.toMatch(/tourist_name|tourist_email|tourist_phone/);
  });

  it('приветствие называет то, что помощник умеет этой роли', () => {
    expect(chat.partnerGreeting(guide)).toMatch(/кто ждёт ответа.*задачу с напоминанием/s);
    expect(chat.partnerGreeting({ ...guide, crmCategory: null })).not.toMatch(/задачу/);
  });
});
