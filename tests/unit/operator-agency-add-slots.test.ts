/**
 * Помощник кабинета «открой даты» (OperatorAgency.addSlots) — после перевода
 * на общую запись дат (22.10, этап B «Открой даты словами»).
 *
 * До 22.10 без числа мест помощник подставлял 10 — число, которого оператор не
 * называл (§4.0), а «1500 мест» читал как 500: регулярка начинала число с его
 * середины. Здесь судится вызовом:
 *   - число мест берётся целиком и только рядом со словом «мест»/«чел»;
 *     хвост даты числом мест не считается; два разных числа — вопрос;
 *   - без числа — вопрос, и до ядра и записи дело не доходит;
 *   - с числом — общая функция зовётся с правилами чата кабинета: открытое
 *     не трогать, закрытое не открывать, сезон и прошлое — проверять, цены нет;
 *   - ответ называет исход каждой даты, «открыто» — только записанное.
 *
 * Что запись делает на настоящей базе (и весь путь через ядро) —
 * tests/integration/tour-dates-open.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openTourDates = vi.fn();
vi.mock('@/lib/tours/availability-open', async (orig) => ({
  ...(await orig<typeof import('@/lib/tours/availability-open')>()),
  openTourDates: (...a: unknown[]) => openTourDates(...a),
}));
const executeGovernedAction = vi.fn();
vi.mock('@/lib/agents/kernel', () => ({
  executeGovernedAction: (...a: unknown[]) => executeGovernedAction(...a),
  hashInput: () => 'hash',
}));
vi.mock('@/lib/operators/team-access', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/team-access')>()),
  operatorAccess: vi.fn(async () => ({ kind: 'owner', partnerId: 'p-1' })),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

const { OperatorAgency, seatsInMessage, addSlotsReport } = await import('@/lib/agents/agencies/operator-agency');

const ctx = {
  user: { userId: '5f3c1a2b-0000-4000-8000-000000000000', role: 'operator' },
  task: {}, platform: { routesCount: 0, activeOperators: 0, toursCount: 0 },
  execution: { agentName: 't', startedAt: new Date() },
} as unknown as Parameters<InstanceType<typeof OperatorAgency>['addSlots']>[0];

beforeEach(() => {
  openTourDates.mockReset();
  executeGovernedAction.mockReset();
  // Ядро здесь — прямой вызов эффекта: policy и журнал судит agent-kernel.
  executeGovernedAction.mockImplementation(async (input: { execute: () => Promise<unknown> }) => {
    try {
      return { ok: true, taskId: 't', traceId: 'tr', result: await input.execute() };
    } catch (err) {
      return { ok: false, taskId: 't', traceId: 'tr', reason: (err as Error).message, state: 'failed_terminal' };
    }
  });
});

describe('число мест во фразе', () => {
  it('целиком, рядом со словом, без хвоста даты', () => {
    expect(seatsInMessage('добавь слоты туру 42 с 2027-07-01 по 2027-07-31, 8 мест')).toEqual({ kind: 'one', value: 8 });
    expect(seatsInMessage('туру 42 2027-07-05 на 12 человек')).toEqual({ kind: 'one', value: 12 });
    expect(seatsInMessage('туру 42 2027-07-05, 1500 мест')).toEqual({ kind: 'bad', value: 1500 });
    expect(seatsInMessage('туру 42 2027-07-05, 0 мест')).toEqual({ kind: 'bad', value: 0 });
    expect(seatsInMessage('туру 42 2027-07-05, 8 мест, нет, 6 мест')).toEqual({ kind: 'two', values: [8, 6] });
    expect(seatsInMessage('туру 42 с 2027-07-01 по 2027-07-31')).toEqual({ kind: 'none' });
  });

  it('кусок чужого числа местами не становится', () => {
    // «1.500 мест» — не 500, хвост даты перед словом «мест» — не 31.
    expect(seatsInMessage('туру 42 2027-07-05, 1.500 мест')).toEqual({ kind: 'none' });
    expect(seatsInMessage('туру 42 с 2027-07-01 по 2027-07-31 мест')).toEqual({ kind: 'none' });
  });
});

describe('addSlots', () => {
  it('без числа мест — вопрос; ни ядра, ни записи: умолчания 10 нет', async () => {
    const res = await new OperatorAgency().addSlots(ctx, 'добавь слоты туру 42 с 2027-07-01 по 2027-07-31');
    expect(res.response).toMatch(/Сколько мест/);
    expect(res.response).toMatch(/Ничего не открыто/);
    expect(executeGovernedAction).not.toHaveBeenCalled();
    expect(openTourDates).not.toHaveBeenCalled();
  });

  it('«1500 мест» и два числа — отказ словами, записи нет', async () => {
    expect((await new OperatorAgency().addSlots(ctx, 'добавь слоты туру 42 2027-07-05, 1500 мест')).response).toMatch(/от 1 до 500/);
    expect((await new OperatorAgency().addSlots(ctx, 'туру 42 2027-07-05, 8 мест или 6 мест')).response).toMatch(/два числа/);
    expect(openTourDates).not.toHaveBeenCalled();
  });

  it('с числом — общая запись с правилами чата кабинета; одна дата тоже понимается', async () => {
    openTourDates.mockResolvedValue({
      ok: true, tour: { title: 'Горелый', maxParticipants: 10, isPublished: true }, written: 1,
      perDate: [{ date: '2027-07-05', result: 'opened' }],
    });
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(openTourDates).toHaveBeenCalledTimes(1);
    const input = openTourDates.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      operatorId: 'p-1', tourId: '42', rows: [{ date: '2027-07-05', slots: 8 }],
      mayPrice: false, skipExisting: true, closedDates: 'keep', enforceSeason: true,
    });
    expect(input.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(executeGovernedAction.mock.calls[0]![0]).toMatchObject({
      capability: 'tour.add_slots', resource: { type: 'tour', id: '42' },
    });
    expect(res.response).toMatch(/Открыто \(1\): 5 июля 2027/);
  });

  it('отказ базы — провал задачи, а не «добавлено 0»', async () => {
    openTourDates.mockResolvedValue({ ok: false, reason: 'failed', sqlstate: '57P01' });
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(res.response).toMatch(/Даты не открыты: база не ответила \(SQLSTATE 57P01\)/);
  });

  it('тур не найден среди включённых — так и сказано', async () => {
    openTourDates.mockResolvedValue({ ok: false, reason: 'tour_not_found' });
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(res.response).toMatch(/Тур 42 не найден среди ваших включённых туров/);
  });

  it('несуществующая дата и перевёрнутый диапазон — до записи', async () => {
    expect((await new OperatorAgency().addSlots(ctx, 'туру 42 2027-02-30, 8 мест')).response).toMatch(/нет в календаре/);
    expect((await new OperatorAgency().addSlots(ctx, 'туру 42 с 2027-07-10 по 2027-07-01, 8 мест')).response).toMatch(/конец раньше начала/);
    expect(openTourDates).not.toHaveBeenCalled();
  });
});

describe('ответ называет исход каждой даты', () => {
  const tour = { title: 'Горелый', maxParticipants: 10, isPublished: false };

  it('ничего не записано — «Ничего не открыто», и ни слова «Открыто (»', () => {
    const text = addSlotsReport({
      ok: true, tour, written: 0,
      perDate: [
        { date: '2027-07-03', result: 'refused_booked', taken: 9 },
        { date: '2027-07-10', result: 'refused_closed', reason: 'Шторм' },
        { date: '2027-10-01', result: 'refused_season', seasonStart: '2027-05-01', seasonEnd: '2027-09-30', from: '2027-05-01', to: '2027-09-30' },
        { date: '2026-10-01', result: 'refused_past' },
        { date: '2028-01-01', result: 'refused_horizon', lastDate: '2027-10-22' },
      ],
    }, 8);
    expect(text.startsWith('Ничего не открыто.')).toBe(true);
    expect(text).not.toMatch(/Открыто \(/);
    expect(text).toMatch(/уже записано больше 8 \(1\): 3 июля 2027 — записано 9/);
    expect(text).toMatch(/закрыли вы.*10 июля 2027 \(«Шторм»\)/);
    expect(text).toMatch(/вне сезона тура \(сезон 1 мая 2027 — 30 сентября 2027; сезон меняется в карточке тура\)/);
    expect(text).toMatch(/дата прошла \(1\): 1 октября 2026/);
    expect(text).toMatch(/дальше года вперёд/);
    // Строка о публикации — только когда что-то открыто.
    expect(text).not.toMatch(/не опубликован/);
  });

  it('открытое, открытое снова и уже открытое — разными строками; неопубликованный тур назван', () => {
    const text = addSlotsReport({
      ok: true, tour, written: 2,
      perDate: [
        { date: '2027-07-03', result: 'opened' },
        { date: '2027-07-04', result: 'reopened', reason: null },
        { date: '2027-07-05', result: 'already_open', slots: 6 },
      ],
    }, 8);
    expect(text).toMatch(/^Тур «Горелый», 8 мест на дату\./);
    expect(text).toMatch(/Открыто \(1\): 3 июля 2027/);
    expect(text).toMatch(/Открыто снова \(1\): 4 июля 2027/);
    expect(text).toMatch(/Уже были открыты, не трогал \(1\): 5 июля 2027 — 6 мест/);
    expect(text).toMatch(/Тур не опубликован/);
  });
});
