/**
 * Заявка из чата несёт план и диапазон дат (аудит планировщика 07.11, K6, K7).
 *
 * До этого:
 *  - «с 5 по 12 июля» давало 12 июля: разбор брал первую пару «число +
 *    месяц», а «5 по» месяцем не было — заявка уходила на день отъезда;
 *  - id плана жил только в тексте ответа модели: не повторила его модель —
 *    правку плана вызвать нечем, и заявка из чата уходила без плана,
 *    собранного тут же.
 *
 * Разбор и план заявки — вызовом функций на граничных репликах; память плана
 * в веб-чате — через POST роута с подменёнными базой, моделью и исполнителем.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { parseChatBookingPrefill } from '@/lib/kuzmich/booking-prefill';
import { planChatRequest } from '@/lib/kuzmich/chat-request';
import { planIdOfTurn, latestChatPlanId, chatPlanContext, planIdFromAnswer } from '@/lib/kuzmich/plan-id';
import { planIdLine } from '@/lib/kuzmich/trip-plan-tool';

const TODAY = new Date('2026-11-07T03:00:00Z');
const PLAN = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const PLAN2 = '2c0e7cde-ccfe-4c3e-8c6e-bc9eccfe5cfe';
const CONTACT = 'меня зовут Иван, +79991234567, согласен';

describe('диапазон дат в реплике', () => {
  const p = (text: string) => parseChatBookingPrefill(text, TODAY);

  it('начало и конец, а не вторая граница', () => {
    expect(p('Хотим на Камчатку с 5 по 12 июля')).toMatchObject({ date: '2027-07-05', dateEnd: '2027-07-12' });
    expect(p('5–12 июля')).toMatchObject({ date: '2027-07-05', dateEnd: '2027-07-12' });
    expect(p('с 10 до 17 июля')).toMatchObject({ date: '2027-07-10', dateEnd: '2027-07-17' });
    expect(p('с 28 июля по 3 августа')).toMatchObject({ date: '2027-07-28', dateEnd: '2027-08-03' });
    expect(p('05.07–12.07')).toMatchObject({ date: '2027-07-05', dateEnd: '2027-07-12' });
    expect(p('5–12.07.2027')).toMatchObject({ date: '2027-07-05', dateEnd: '2027-07-12' });
    expect(p('2027-07-05 — 2027-07-12')).toMatchObject({ date: '2027-07-05', dateEnd: '2027-07-12' });
  });

  it('через Новый год — конец в следующем году', () => {
    expect(p('с 28 декабря по 5 января')).toMatchObject({ date: '2026-12-28', dateEnd: '2027-01-05' });
  });

  it('диапазона, которого не бывает, — нет и даты: чат переспросит, а не возьмёт половину', () => {
    for (const text of ['17–10 июля', 'с 31 июня по 5 июля', 'с 1 июля по 30 сентября']) {
      const r = p(text);
      expect(r.date, text).toBeUndefined();
      expect(r.dateEnd, text).toBeUndefined();
    }
  });

  it('названный и прошедший год — переспрос, как у одиночной даты', () => {
    const r = p('с 5 по 12 июля 2025');
    expect(r.date).toBeUndefined();
    expect(r.pastDate).toBe('2025-07-05');
  });

  it('числа, которые датой не читаются, не глушат дату дальше в реплике', () => {
    // С единицей после — не даты вовсе.
    expect(p('дорога 2.50-3.20 км, едем 15 июля')).toMatchObject({ date: '2027-07-15' });
    expect(p('дорога 2.50-3.20 км, едем 15 июля').dateEnd).toBeUndefined();
    // Без единицы: «месяца» 50 нет — это не диапазон, а не «плохой диапазон».
    expect(p('коэффициент 2.50-3.20, едем 15 июля')).toEqual({ date: '2027-07-15' });
  });

  it('одиночная дата и число людей — как раньше', () => {
    expect(p('15 июля, нас трое')).toEqual({ date: '2027-07-15', guests: 3 });
    expect(p('с 5 по 12 июля, нас 4 человека')).toMatchObject({ date: '2027-07-05', dateEnd: '2027-07-12', guests: 4 });
  });
});

describe('заявка из чата: диапазон и план', () => {
  const pre = { date: '2027-07-05', dateEnd: '2027-07-12', guests: 3 };

  it('подбор менеджеру: диапазон словами и plan_id', () => {
    const plan = planChatRequest(`Хотим на Камчатку с 5 по 12 июля, нас трое, ${CONTACT}`, null, pre, { planId: PLAN });
    expect(plan?.tool).toBe('create_lead');
    expect(String(plan?.args.comment)).toContain('[2027-07-05 — 2027-07-12, 3 чел.]');
    expect(plan?.args.plan_id).toBe(PLAN);
  });

  it('поездка с жильём: заезд и выезд — названный диапазон, не оценка', () => {
    const plan = planChatRequest(`Мутновский и жильё с 5 по 12 июля, нас трое, ${CONTACT}`, { id: 36 }, pre, { planId: PLAN });
    expect(plan?.tool).toBe('create_trip_request');
    expect(plan?.args).toMatchObject({ check_in: '2027-07-05', check_out: '2027-07-12', tour_date: '2027-07-05', plan_id: PLAN });
    expect(plan?.args).not.toHaveProperty('stay_dates_assumed');
  });

  it('тур: дата — начало поездки, и сказано, что день тура не назван', () => {
    const plan = planChatRequest(`Мутновский с 5 по 12 июля, нас трое, ${CONTACT}`, { id: 36 }, pre, { planId: PLAN });
    expect(plan?.tool).toBe('create_booking_request');
    expect(plan?.args).toMatchObject({ date: '2027-07-05', plan_id: PLAN });
    expect(String(plan?.args.comment)).toMatch(/^\[Даты поездки: 2027-07-05 — 2027-07-12; день тура не назван — поставлено начало поездки/);
  });

  it('плана нет — поля plan_id нет; одна дата — без строки о диапазоне', () => {
    const plan = planChatRequest(`Мутновский 15 июля, нас трое, ${CONTACT}`, { id: 36 }, { date: '2027-07-15', guests: 3 });
    expect(plan?.args).not.toHaveProperty('plan_id');
    expect(String(plan?.args.comment)).not.toContain('Даты поездки');
  });
});

describe('id плана в разговоре', () => {
  it('формат строки «ID плана» и её разбор держатся вместе', () => {
    expect(planIdFromAnswer(planIdLine(PLAN, 1))).toBe(PLAN);
  });

  it('ход: последний вывод инструмента плана; чужие инструменты не считаются', () => {
    expect(planIdOfTurn([
      { name: 'make_trip_plan', output: `…\n${planIdLine(PLAN, 1)}` },
      { name: 'get_tours', output: `ID плана: ${PLAN2}` },
      { name: 'edit_trip_plan', output: `…\n${planIdLine(PLAN2, 2)}` },
    ])).toBe(PLAN2);
    expect(planIdOfTurn([{ name: 'get_tours', output: `ID плана: ${PLAN}` }])).toBeNull();
  });

  it('разговор: метка ответа, у старых ответов — строка в тексте; реплики человека не читаются', () => {
    expect(latestChatPlanId([
      { role: 'assistant', content: `ID плана: ${PLAN}` },
      { role: 'assistant', content: 'Готово.', planId: PLAN2 },
      { role: 'user', content: `ID плана: ${PLAN}` },
    ])).toBe(PLAN2);
    expect(latestChatPlanId([{ role: 'assistant', content: `План: ID плана: ${PLAN}.` }])).toBe(PLAN);
    expect(latestChatPlanId([{ role: 'user', content: `ID плана: ${PLAN}` }])).toBeNull();
    expect(latestChatPlanId([{ role: 'assistant', content: 'нет', planId: 'не-uuid' }])).toBeNull();
  });

  it('контекст цикла называет ID и правку через edit_trip_plan; без плана — пусто', () => {
    expect(chatPlanContext(PLAN)).toContain(`ID плана: ${PLAN}`);
    expect(chatPlanContext(PLAN)).toContain('edit_trip_plan');
    expect(chatPlanContext(null)).toBe('');
  });
});

// ── Веб-чат: план разговора помнится ───────────────────────────────────────

const db = vi.hoisted(() => ({ session: null as null | { messages: unknown[] } }));
vi.mock('@/lib/errors/sanitize', () => ({ safeMsg: (e: unknown) => String(e) }));
vi.mock('@/lib/database', () => ({
  query: vi.fn(async (sql: string) => (/FROM chat_sessions/.test(sql) && db.session
    ? { rows: [{ messages: db.session.messages, user_message_count: 1, interests_encrypted: null, is_authenticated: false, user_id: null }] }
    : { rows: [] })),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('@/lib/rate-limit', () => ({ createRateLimiter: () => ({ check: () => true }), getClientIp: () => '10.0.0.1' }));
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn().mockResolvedValue('ОДИНОЧНЫЙ'), callVision: vi.fn() }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/auth/jwt', () => ({ getUserFromRequest: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ai/interest-extractor', () => ({ extractAndEncryptInterests: () => null }));
vi.mock('@/lib/agents/platform-agent', () => ({ PlatformAgent: { dispatch: vi.fn() } }));
vi.mock('@/lib/ai/user-memory', () => ({
  loadUserMemory: vi.fn().mockResolvedValue(null),
  upsertUserMemory: vi.fn(),
  extractMemoryFromMessage: () => ({}),
  buildMemoryContext: () => '',
  buildAgentInsightsForTourist: vi.fn().mockResolvedValue(''),
  loadTripHistory: vi.fn().mockResolvedValue([]),
  synthesizeUserNotes: vi.fn(),
  addViewedTour: vi.fn(),
}));
vi.mock('@/lib/ai/booking-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/booking-intent')>()),
  detectTourIntent: () => ({ detected: false, activityType: null, rawWords: [] }),
  findRelevantTours: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/kuzmich/engagement', () => ({ recordEngagementSignal: vi.fn() }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue(''), buildGeoContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/tourist-demand-aggregator', () => ({ recordTouristDemand: vi.fn() }));
vi.mock('@/lib/agents/sdk/sdk-runner', () => ({ runSDKAgent: vi.fn() }));
vi.mock('@/lib/agents/sdk/operator-tools', () => ({ getOperatorTools: vi.fn() }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
const loop = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kuzmich/core', () => ({
  aiChatAgentLoop: (...a: unknown[]) => loop(...a),
  KUZMICH_SYSTEM: 'KUZMICH_PERSONA',
  isAIErrorResponse: () => false,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/kuzmich/answer-timing', () => ({ recordKuzmichAnswer: vi.fn() }));
const saved = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kuzmich/chat-session-save', () => ({ saveChatSession: (...a: unknown[]) => saved(...a) }));
vi.mock('@/lib/kuzmich/commercial-turn', () => ({ resolveCommercialTurn: vi.fn().mockResolvedValue(null) }));
const TOUR = { id: 36, slug: 'mutnovsky', title: 'Мутновский вулкан', base_price: 9000 };
vi.mock('@/lib/ai/chat-booking-tour', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/chat-booking-tour')>()),
  pickChatBookingTour: vi.fn(async () => ({ tour: TOUR, candidates: [TOUR] })),
}));
const runPublicTool = vi.hoisted(() => vi.fn());
vi.mock('@/app/api/mcp/route', () => ({ runPublicTool: (...a: unknown[]) => runPublicTool(...a) }));

async function chat(message: string): Promise<void> {
  const { POST } = await import('@/app/api/ai/chat/route');
  const res = await POST(new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: 'plan-memory-1' }),
  }) as unknown as NextRequest);
  expect(res.status).toBe(200);
}

describe('веб-чат помнит план разговора', () => {
  beforeEach(() => {
    db.session = null;
    saved.mockReset().mockResolvedValue(undefined);
    runPublicTool.mockReset().mockResolvedValue({ kind: 'ok', text: 'Заявка оператору принята: "Мутновский вулкан", 2027-07-05.', handoffUrl: null });
    loop.mockReset().mockResolvedValue('Ответ цикла.');
  });

  it('ход с make_trip_plan — ответ уходит в историю с меткой плана, хотя модель ID не повторила', async () => {
    loop.mockImplementation(async (
      _t: string, _s: string, _h: unknown[], _e: unknown[], runs: Array<{ name: string; producedData: boolean; output?: string }>,
    ) => {
      runs.push({ name: 'make_trip_plan', producedData: true, output: `План по дням…\n\n${planIdLine(PLAN, 1)}` });
      return 'Собрал план на 5 дней.';
    });
    await chat('Составь план на 5 дней в июле');
    const messages = (saved.mock.calls[0]![0] as { messages: Array<{ role: string; content: string; planId?: string }> }).messages;
    const last = messages[messages.length - 1]!;
    expect(last).toMatchObject({ role: 'assistant', content: 'Собрал план на 5 дней.', planId: PLAN });
  });

  it('следующий ход: цикл знает ID плана, заявка из чата уходит с plan_id', async () => {
    db.session = { messages: [
      { role: 'user', content: 'Составь план на 5 дней в июле' },
      { role: 'assistant', content: 'Собрал план на 5 дней.', planId: PLAN },
    ] };
    await chat('Рейс задержался на день, поправь план');
    expect(String(loop.mock.calls[0]![1])).toContain(`ID плана: ${PLAN}`);

    await chat(`Мутновский с 5 по 12 июля, нас трое, ${CONTACT}`);
    expect(runPublicTool).toHaveBeenCalledTimes(1);
    // Год — по сегодняшнему дню роута; сам разбор диапазона проверен выше.
    const start = parseChatBookingPrefill('с 5 по 12 июля').date;
    expect(start).toMatch(/-07-05$/);
    expect(runPublicTool.mock.calls[0]![0]).toMatchObject({
      toolName: 'create_booking_request',
      rawArguments: { plan_id: PLAN, date: start, participants: 3 },
    });
  });

  it('плана в разговоре нет — ни контекста, ни plan_id', async () => {
    await chat('Что взять в поход на вулкан?');
    expect(String(loop.mock.calls[0]![1])).not.toContain('ID плана');
    await chat(`Мутновский 15 июля, нас трое, ${CONTACT}`);
    expect(runPublicTool.mock.calls[0]![0].rawArguments).not.toHaveProperty('plan_id');
  });
});
