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
 *  - в промпт оператора бронь идёт номером, без имени туриста;
 *  - гид со своими турами (29.10) получает то же знание туров, что
 *    туроператор: сводку и my_tours_schedule; гид команды без туров — нет.
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
    expect(r).toEqual({ outcome: 'found', partner: { partnerId: 'p-1', partnerName: 'Вулкан-Тур', slug: null, category: 'guide', crmCategory: 'guide', userId: 'u-1', sellsTours: false } });
    expect(query.mock.calls[0][0]).toMatch(/NULLIF\(btrim\(slug\), ''\) AS slug/);
    expect(query.mock.calls[0][0]).toMatch(/WHERE max_chat_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual([777]);

    query.mockResolvedValueOnce({ rows: [row()] });
    await chat.findPartnerByChat('telegram', 5);
    expect(query.mock.calls[1][0]).toMatch(/WHERE telegram_chat_id = \$1/);
  });

  it('свои туры — тем же запросом: колонка базы true — продаёт; нет колонки или NULL — нет', async () => {
    query.mockResolvedValueOnce({ rows: [row({ sells_tours: true })] });
    expect(await chat.findPartnerByChat('max', 1)).toMatchObject({ partner: { category: 'guide', sellsTours: true } });
    query.mockResolvedValueOnce({ rows: [row({ sells_tours: null })] });
    expect(await chat.findPartnerByChat('max', 1)).toMatchObject({ partner: { sellsTours: false } });
    expect(query).toHaveBeenCalledTimes(2);
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

  it('прокатчик пилота на «покажи машины» получает прайс, модель не зовётся', async () => {
    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
    query.mockResolvedValue({ rows: [{
      title: 'Suzuki Jimny', body_kind: 'suv', price_rub_per_day: 7000, price_is_from: false,
      deposit_rub: null, is_active: true, driver: 'self',
    }] });
    await chat.processPartnerMessage({
      chatId: 9, text: 'покажи машины', fromName: null, reply, nowMs: NOW,
      partner: { ...guide, partnerName: 'Лагуна Прокат', slug: 'laguna-prokat', category: 'transfer', crmCategory: 'transfer' },
    });
    expect(callToolsWaterfall).not.toHaveBeenCalled();
    expect(callAIWaterfallOrNull).not.toHaveBeenCalled();
    expect(String(reply.mock.calls[0][1])).toContain('Suzuki Jimny');
    expect(String(reply.mock.calls[0][1])).toContain('залог не записан');
  });

  it('приветствие называет то, что помощник умеет этой роли', () => {
    expect(chat.partnerGreeting(guide)).toMatch(/кто ждёт ответа.*задачу с напоминанием/s);
    expect(chat.partnerGreeting({ ...guide, crmCategory: null })).not.toMatch(/задачу/);
  });

  it('«открой даты словами» (22.10): оператору — даты сам не меняешь и не говоришь «открыл»; перевозчику строки нет', () => {
    // Даты открывает поток с кнопкой подтверждения, а не модель: без строки
    // помощник на непонятую фразу мог ответить «открыл», не открыв.
    const operator = { ...guide, category: 'operator', crmCategory: 'operator' as const };
    for (const tools of [true, false]) {
      expect(chat.partnerSystemPrompt(operator, NOW, tools)).toMatch(/Даты и места туров ты сам не меняешь и не говоришь, что открыл или закрыл/);
      expect(chat.partnerSystemPrompt(operator, NOW, tools)).toMatch(/кнопкой «Открыть»/);
    }
    const carrier = { ...guide, category: 'transfer', crmCategory: 'transfer' as const };
    expect(chat.partnerSystemPrompt(carrier, NOW, true)).not.toMatch(/Даты и места туров/);
    expect(chat.partnerSystemPrompt(guide, NOW, true)).not.toMatch(/Даты и места туров/);
  });

  it('четвёртый ревью: гиду, перевозчику, владельцу жилья фраза с «открой» и датой приходит сюда — помощник не говорит «открыл»', () => {
    // Поток дат отдаёт их сообщения помощнику (как до этапа C), а календаря у
    // помощника нет: строка держит его от «открыл», не открыв.
    for (const category of ['guide', 'transfer', 'stay'] as const) {
      for (const tools of [true, false]) {
        expect(chat.partnerSystemPrompt({ ...guide, category, crmCategory: category }, NOW, tools))
          .toMatch(/Календарь, даты и свободные места ты не меняешь и не говоришь, что открыл или закрыл их/);
      }
    }
    const operator = { ...guide, category: 'operator', crmCategory: 'operator' as const };
    expect(chat.partnerSystemPrompt(operator, NOW, true)).not.toMatch(/Календарь, даты/);
  });
});

describe('гид со своими турами (29.10): помощник знает его туры, как туроператор', () => {
  const base = { partnerId: 'p-1', partnerName: 'Гид', category: 'guide', crmCategory: 'guide' as const, userId: 'u-1' };
  const seller = { ...base, sellsTours: true };
  const team = { ...base, sellsTours: false };
  const reply = vi.fn(async () => undefined);
  beforeEach(() => reply.mockReset());

  /** Сводка туров и броней: брони без имён, как у туроператора. */
  function bizRows(): void {
    query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours\s+WHERE operator_id = \$1\s+AND deleted_at IS NULL\s+ORDER BY is_active DESC, created_at DESC\s+LIMIT 10/.test(sql)) {
        return { rows: [{ id: 7, title: 'Авторский тур', base_price: 15000, is_active: true, is_published: false, available_slots: null }] };
      }
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ cnt: '1', awaiting: '1' }] };
      if (/ob\.participants/.test(sql)) {
        return { rows: [{ id: '501', booking_date: '2026-11-05', participants: 2, final_price: 30000, booking_status: 'new' }] };
      }
      // my_tours_schedule: туров по запросу нет — до дат дело не доходит.
      return { rows: [] };
    });
  }

  const toolNames = (call: number) =>
    (callToolsWaterfall.mock.calls[call][1] as Array<{ function: { name: string } }>).map((t) => t.function.name);

  it('гид-продавец: сводка его туров и броней в промпте, инструмент расписания есть', async () => {
    bizRows();
    callToolsWaterfall.mockResolvedValueOnce({ content: 'Одна бронь ждёт.', tool_calls: null });
    await chat.processPartnerMessage({ chatId: 9, text: 'какие у меня брони?', fromName: null, partner: seller, reply, nowMs: NOW });

    expect(toolNames(0)).toContain('my_tours_schedule');
    const system = (callToolsWaterfall.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).toMatch(/МОИ ТУРЫ:\n- "Авторский тур" \| 15[\s\u00a0]000 ₽\/чел \| активен, скрыт с витрины/);
    expect(system).toMatch(/бронь №501, 2 чел/);
    expect(system).toMatch(/Ждут вашего подтверждения: 1/);
    expect(system).toMatch(/инструментом my_tours_schedule/);
    // Его даты: в MAX — фраза с кнопкой «Открыть» (поток дат открыт гиду с
    // турами, шаг 8), на сайте — раздел «Свои туры»; кабинета оператора нет.
    expect(system).toMatch(/Даты и места своих туров ты сам не меняешь/);
    expect(system).toMatch(/В MAX гид открывает их фразой «открой субботы июля, 8 мест» с кнопкой «Открыть»/);
    expect(system).toMatch(/раздел «Свои туры»: https?:\/\/\S+\/hub\/guide\/own/);
    expect(system).not.toMatch(/hub\/operator/);
    // Сводка — по его карточке из чата.
    const tourSql = query.mock.calls.find((c) => /FROM operator_tours\s+WHERE operator_id = \$1/.test(String(c[0])));
    expect(tourSql?.[1]).toEqual(['p-1']);
  });

  it('гид-продавец: расписание спрашивается по карточке из чата, а не по аргументу модели', async () => {
    bizRows();
    callToolsWaterfall
      .mockResolvedValueOnce({ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'my_tours_schedule', arguments: '{"tour":"Горелый","partner_id":"чужой"}' } }] })
      .mockResolvedValueOnce({ content: 'Такого тура нет.', tool_calls: null });
    await chat.processPartnerMessage({ chatId: 9, text: 'какие даты открыты на Горелый?', fromName: null, partner: seller, reply, nowMs: NOW });

    const schedule = query.mock.calls.find((c) => /operator_id = \$1::uuid/.test(String(c[0])));
    expect(schedule?.[1]?.[0]).toBe('p-1');
    expect(schedule?.[1]?.[1]).toBe('Горелый');
    expect(executeCrmTool).not.toHaveBeenCalled();
    const second = callToolsWaterfall.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(second.find((m) => m.role === 'tool')?.content).toMatch(/Среди своих туров нет подходящего под «Горелый»/);
    expect(reply).toHaveBeenCalledWith(9, 'Такого тура нет.');
  });

  it('гид команды без своих туров — как до 29.10: ни сводки, ни расписания, ни запроса туров', async () => {
    bizRows();
    callToolsWaterfall.mockResolvedValueOnce({ content: 'Смотрю входящие.', tool_calls: null });
    await chat.processPartnerMessage({ chatId: 9, text: 'какие у меня брони?', fromName: null, partner: team, reply, nowMs: NOW });

    expect(toolNames(0).every((n) => n.startsWith('crm_'))).toBe(true);
    const system = (callToolsWaterfall.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).not.toMatch(/МОИ ТУРЫ|my_tours_schedule|Свои туры/);
    expect(system).toMatch(/Календарь, даты и свободные места ты не меняешь/);
    expect(query.mock.calls.some((c) => /operator_tours/.test(String(c[0])))).toBe(false);
  });

  it('гид-продавец без инструментов (водопад инструментов молчит) — сводка туров всё равно в промпте', async () => {
    bizRows();
    callToolsWaterfall.mockResolvedValueOnce(null);
    callAIWaterfallOrNull.mockResolvedValueOnce('Бронь №501 ждёт.');
    await chat.processPartnerMessage({ chatId: 9, text: 'брони?', fromName: null, partner: seller, reply, nowMs: NOW });
    const system = (callAIWaterfallOrNull.mock.calls[0][0] as Array<{ content: string }>)[0].content;
    expect(system).toMatch(/бронь №501/);
    expect(system).not.toMatch(/my_tours_schedule/);
  });

  it('перевозчик и владелец жилья с полем «продаёт» — не продавцы туров: признак только у гида', () => {
    for (const category of ['transfer', 'stay', 'agent'] as const) {
      const p = { ...base, category, crmCategory: category, sellsTours: true };
      expect(chat.partnerSystemPrompt(p, NOW, true)).not.toMatch(/my_tours_schedule|Свои туры/);
    }
  });
});
