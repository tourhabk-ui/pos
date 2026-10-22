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
 *   - ответ называет исход каждой даты, «открыто» — только записанное;
 *   - фраза без глагола открытия, с закрытием (любым: «закрой», «заблокируй»,
 *     «скрой», «стоп»), отрицанием, исключением или вопросом сюда приходит по
 *     ключу классификатора («слоты на») — и не исполняется;
 *   - две даты через «и» — ровно две, а не все дни между ними; дни недели —
 *     отказ, а не каждый день диапазона; «тур 2027-07-05» — не тур 2027;
 *   - образец кнопки экрана («туру <номер>») ничего не пишет;
 *   - номер тура из поля «Tour ID» (роут дописывает «тур 42») понимается;
 *   - цена во фразе названа словами, а не пропущена молча;
 *   - ядро ответило отказом ПОСЛЕ записи — ответ не говорит «не открыты».
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
const { classifyIntentByKeywords } = await import('@/lib/agents/intent-classifier');

const openedOne = (date = '2027-07-05') => ({
  ok: true, tour: { title: 'Горелый', maxParticipants: 10, isPublished: true, isActive: true }, written: 1,
  perDate: [{ date, result: 'opened' }],
});

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
    expect((await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест или 6 мест')).response).toMatch(/два числа/);
    expect(openTourDates).not.toHaveBeenCalled();
  });

  it('с числом — общая запись с правилами чата кабинета; одна дата тоже понимается', async () => {
    openTourDates.mockResolvedValue(openedOne());
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(openTourDates).toHaveBeenCalledTimes(1);
    const input = openTourDates.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      operatorId: 'p-1', tourId: '42', rows: [{ date: '2027-07-05', slots: 8 }],
      mayPrice: false, inactiveTour: 'refuse', skipExisting: true, closedDates: 'keep', enforceSeason: true,
    });
    expect(input.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(executeGovernedAction.mock.calls[0]![0]).toMatchObject({
      capability: 'tour.add_slots', resource: { type: 'tour', id: '42' },
    });
    expect(res.response).toMatch(/Открыто \(1\): 5 июля 2027/);
    // Цены во фразе нет — и строки о цене нет.
    expect(res.response).not.toMatch(/Цену/);
  });

  it('отказ базы — провал задачи, а не «добавлено 0»', async () => {
    openTourDates.mockResolvedValue({ ok: false, reason: 'failed', sqlstate: '57P01' });
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(res.response).toMatch(/Даты не открыты: база не ответила \(SQLSTATE 57P01\)/);
  });

  it('тура нет — «не найден»; тур скрыт — «скрыт» с названием и как включить', async () => {
    openTourDates.mockResolvedValue({ ok: false, reason: 'tour_not_found' });
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(res.response).toMatch(/Тур 42 не найден среди ваших туров/);

    openTourDates.mockResolvedValue({ ok: false, reason: 'tour_inactive', title: 'Горелый' });
    const hidden = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(hidden.response).toMatch(/Тур «Горелый» скрыт/);
    expect(hidden.response).toMatch(/«Показать» в списке туров/);
    expect(hidden.response).not.toMatch(/не найден/);
  });

  it('ядро отказало ПОСЛЕ записи — ответ называет записанное и сбой журнала, а не «не открыты»', async () => {
    openTourDates.mockResolvedValue(openedOne());
    executeGovernedAction.mockImplementation(async (input: { execute: () => Promise<unknown> }) => {
      await input.execute();
      return { ok: false, taskId: 't', traceId: 'tr', reason: 'эффект исполнен, но терминальный переход не записан: x', state: 'running' };
    });
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(res.response).not.toMatch(/Даты не открыты/);
    expect(res.response).toMatch(/Открыто \(1\): 5 июля 2027/);
    expect(res.response).toMatch(/Журнал задач помощника не дописан \(эффект исполнен, но терминальный переход не записан: x\)/);
    expect(res.response).toMatch(/\/hub\/operator\/calendar/);
  });

  it('ядро отказало ДО записи (ресурс занят) — «не открыты», и это правда: записи не было', async () => {
    executeGovernedAction.mockResolvedValue({
      ok: false, taskId: null, traceId: null, reason: 'tour:42 занят другой задачей', state: 'running',
    });
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-07-05, 8 мест');
    expect(openTourDates).not.toHaveBeenCalled();
    expect(res.response).toBe('Даты не открыты: tour:42 занят другой задачей');
  });

  it('номер тура из поля «Tour ID»: роут дописывает «тур 42» в конец — понимается; два разных номера — вопрос', async () => {
    openTourDates.mockResolvedValue(openedOne());
    // Ровно то, что пишет /api/agents/operator: `${message} тур ${tourId}`.
    await new OperatorAgency().addSlots(ctx, 'открой даты 2027-07-05, 8 мест тур 42');
    expect(openTourDates.mock.calls[0]![0]).toMatchObject({ tourId: '42' });

    openTourDates.mockClear();
    const two = await new OperatorAgency().addSlots(ctx, 'открой даты туру 43 2027-07-05, 8 мест тур 42');
    expect(two.response).toMatch(/несколько туров \(43, 42\)/);
    expect(openTourDates).not.toHaveBeenCalled();
  });

  it('цена во фразе: даты открыты по правилам помощника, и сказано, что цену он не меняет', async () => {
    openTourDates.mockResolvedValue(openedOne());
    for (const phrase of [
      'открой даты туру 42 2027-07-05, 8 мест по 15000 руб',
      'открой даты туру 42 2027-07-05, 8 мест по 15 000',
      'открой даты туру 42 2027-07-05, 8 мест, цена 9000',
      'открой даты туру 1042 2027-07-05, 8 мест, 500р.',
    ]) {
      const res = await new OperatorAgency().addSlots(ctx, phrase);
      expect(res.response, phrase).toMatch(/Цену из помощника не меняю/);
    }
    // Ни год даты, ни номер тура, ни места ценой не считаются.
    const plain = await new OperatorAgency().addSlots(ctx, 'добавь слоты туру 1042 с 2027-07-01 по 2027-07-05, 12 человек');
    expect(plain.response).not.toMatch(/Цену/);
    for (const call of openTourDates.mock.calls) {
      expect((call[0] as { rows: Array<{ price?: unknown }> }).rows.every((r) => r.price === undefined)).toBe(true);
    }
  });

  it('несуществующая дата и перевёрнутый диапазон — до записи', async () => {
    expect((await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-02-30, 8 мест')).response).toMatch(/нет в календаре/);
    expect((await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 с 2027-07-10 по 2027-07-01, 8 мест')).response).toMatch(/конец раньше начала/);
    expect(openTourDates).not.toHaveBeenCalled();
  });
});

describe('фраза «закрой / не открывай / кроме» — ни одной записи (ключ «слоты на» ведёт её сюда)', () => {
  it.each([
    ['закрой слоты на 2027-07-05 туру 42, группа 8 человек набрана', /Закрыть, убрать или уменьшить даты из помощника нельзя.*«закрой»/],
    ['не надо открывать — убери слоты на 2027-07-05 туру 42, 8 мест', /отказ \(«не надо открывать»\)/],
    ['не открывай слоты на 2027-07-05 туру 42, 8 мест', /отказ \(«не открывай»\)/],
    ['удали слоты на 2027-07-05 туру 42, 8 мест', /Закрыть, убрать.*«удали»/],
    ['сними слоты на 2027-07-05 туру 42, 8 мест', /Закрыть, убрать.*«сними»/],
    ['отмени слоты на 2027-07-05 туру 42, 8 мест', /Закрыть, убрать.*«отмени»/],
    ['добавь слоты туру 42 с 2027-07-01 по 2027-07-31 кроме 2027-07-17, 8 мест', /Исключения \(«кроме»\)/],
    ['открой даты туру 42 с 2027-07-01 по 2027-07-31 без 17, 8 мест', /Исключения \(«без 17»\)/],
    // Ревью 22.10: синонимы закрытия обходили запретный список и ОТКРЫВАЛИ дату.
    ['заблокируй слоты на 2027-07-05 туру 42, группа 8 человек набрана', /Закрыть, убрать.*«заблокируй»/],
    ['скрой слоты на 2027-07-05 туру 42, там уже 8 человек', /Закрыть, убрать.*«скрой»/],
    ['отключи слоты на 2027-07-05 туру 42, 8 мест продали сами', /Закрыть, убрать.*«отключи»/],
    ['останови продажу: слоты на 2027-07-05 туру 42, 8 человек', /Закрыть, убрать.*«останови»/],
    ['стоп слоты на 2027-07-05 туру 42, 8 человек', /Закрыть, убрать.*«стоп»/],
    // Вопрос — не просьба открыть.
    ['есть ли свободные слоты на 2027-07-05 по туру 42 для 8 человек', /Это вопрос/],
    // Нет глагола открытия — не исполняется, каким бы ни был ключ.
    ['новые слоты на 2027-07-05 туру 42, 8 мест', /Не понял, что сделать с датами/],
    ['слоты на 2027-07-05 туру 42, 8 мест, тур Горелый', /Не понял, что сделать с датами/],
  ])('«%s»', async (phrase, answer) => {
    expect(classifyIntentByKeywords(phrase, 'operator')).toBe('op_add_slots');
    const res = await new OperatorAgency().addSlots(ctx, phrase);
    expect(res.response).toMatch(answer);
    expect(res.response).toMatch(/Ничего не изменено/);
    expect(openTourDates).not.toHaveBeenCalled();
    expect(executeGovernedAction).not.toHaveBeenCalled();
  });

  it('обычная фраза открытия отказом не считается', async () => {
    openTourDates.mockResolvedValue(openedOne());
    for (const phrase of [
      'добавь слоты туру 42 с 2027-07-01 по 2027-07-31, 8 мест',
      'открой даты туру 42 2027-07-05, 8 мест',
      'открой слоты на 2027-07-05 туру 42, 8 мест, тур Горелый',
    ]) {
      const res = await new OperatorAgency().addSlots(ctx, phrase);
      expect(res.response, phrase).not.toMatch(/Ничего не изменено/);
    }
    expect(openTourDates).toHaveBeenCalledTimes(3);
  });
});

describe('какие даты: ровно названные, а не догадка', () => {
  const rowsOf = (i = 0) => (openTourDates.mock.calls[i]![0] as { rows: Array<{ date: string }> }).rows.map((r) => r.date);

  it('«A и B» — ровно две даты, а не все дни между ними; «с A по B» — все дни', async () => {
    openTourDates.mockResolvedValue(openedOne());
    await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-08-05 и 2027-08-12, 6 мест');
    expect(rowsOf(0)).toEqual(['2027-08-05', '2027-08-12']);
    await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 2027-08-05, 2027-08-12 и 2027-08-19, 6 мест');
    expect(rowsOf(1)).toEqual(['2027-08-05', '2027-08-12', '2027-08-19']);
    await new OperatorAgency().addSlots(ctx, 'открой даты туру 42 с 2027-08-05 по 2027-08-12, 6 мест');
    expect(rowsOf(2)).toHaveLength(8);
  });

  it('связь дат не названа — вопрос, записи нет', async () => {
    for (const phrase of [
      'открой даты туру 42 2027-08-05 2027-08-12, 6 мест',
      'открой даты туру 42 с 2027-08-05, 6 мест',
    ]) {
      const res = await new OperatorAgency().addSlots(ctx, phrase);
      expect(res.response, phrase).toMatch(/Ничего не открыто/);
    }
    expect(openTourDates).not.toHaveBeenCalled();
    expect(executeGovernedAction).not.toHaveBeenCalled();
  });

  it('второй ревью 22.10: подсказка на «как связаны даты» — команда целиком, которую помощник исполняет', async () => {
    // Голое «с A по B» классификатор помощнику не отдаёт: ответ по подсказке
    // уходил мимо. Каждая подсказка в кавычках — ключ op_add_slots и исполнение
    // без того же вопроса; названные места — в подсказке.
    const cases: Array<[string, number | null]> = [
      ['открой даты туру 42 2027-08-05 2027-08-12, 6 мест', 6],
      ['открой даты туру 42 с 2027-08-05, 6 мест', 6],
      ['открой даты туру 42 2027-08-05 2027-08-12', null],
    ];
    for (const [phrase, seats] of cases) {
      const res = await new OperatorAgency().addSlots(ctx, phrase);
      const hints = [...res.response.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      expect(hints.length, res.response).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(classifyIntentByKeywords(hint, 'operator'), hint).toBe('op_add_slots');
        openTourDates.mockReset();
        openTourDates.mockResolvedValue(openedOne('2027-08-05'));
        const again = await new OperatorAgency().addSlots(ctx, hint);
        expect(again.response, hint).not.toMatch(/как связаны даты|С какой и по какую/);
        if (seats === null) {
          expect(again.response, hint).toMatch(/Сколько мест открыть/);
          expect(openTourDates).not.toHaveBeenCalled();
        } else {
          expect(openTourDates, hint).toHaveBeenCalledTimes(1);
          expect((openTourDates.mock.calls[0]![0] as { rows: Array<{ slots: number }> }).rows.every((r) => r.slots === seats)).toBe(true);
        }
      }
    }
  });

  it('дни недели — отказ словами: помощник их не применит и не откроет каждый день', async () => {
    const res = await new OperatorAgency().addSlots(ctx, 'добавь слоты по субботам с 2027-07-01 по 2027-07-31 туру 42, 8 мест');
    expect(res.response).toMatch(/Дни недели и периодичность \(«субботам»\)/);
    expect(res.response).toMatch(/\/hub\/operator\/calendar/);
    expect(res.response).toMatch(/Ничего не открыто/);
    expect((await new OperatorAgency().addSlots(ctx, 'открой выходные туру 42 с 2027-07-01 по 2027-07-31, 8 мест')).response)
      .toMatch(/«выходные»/);
    expect(openTourDates).not.toHaveBeenCalled();
    expect(executeGovernedAction).not.toHaveBeenCalled();
  });

  it('«на тур 2027-07-05» — год даты не номер тура: подсказка, ядро не зовётся', async () => {
    const res = await new OperatorAgency().addSlots(ctx, 'открой даты на тур 2027-07-05, 8 мест');
    expect(res.response).toMatch(/Укажи ID тура/);
    expect(executeGovernedAction).not.toHaveBeenCalled();
    // С полем «Tour ID» (роут дописывает «тур 42») — тур 42, а не «несколько туров».
    openTourDates.mockResolvedValue(openedOne());
    await new OperatorAgency().addSlots(ctx, 'открой даты на тур 2027-07-05, 8 мест тур 42');
    expect(openTourDates.mock.calls[0]![0]).toMatchObject({ tourId: '42', rows: [{ date: '2027-07-05', slots: 8 }] });
  });

  it('образец кнопки экрана («туру <номер>») ничего не пишет — подсказка', async () => {
    const { OPERATOR_COMMAND_EXAMPLES } = await import('@/lib/agents/operator-commands');
    const chip = OPERATOR_COMMAND_EXAMPLES.find((e) => e.intent === 'op_add_slots')!;
    const res = await new OperatorAgency().addSlots(ctx, chip.message);
    expect(res.response).toMatch(/Укажи ID тура/);
    expect(openTourDates).not.toHaveBeenCalled();
    expect(executeGovernedAction).not.toHaveBeenCalled();
  });
});

describe('ответ называет исход каждой даты', () => {
  const tour = { title: 'Горелый', maxParticipants: 10, isPublished: false, isActive: true };

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
    expect(text).toMatch(/уже записано больше, чем 8 мест \(1\): 3 июля 2027 — записано 9 человек/);
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
