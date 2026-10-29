/**
 * Коммерческий эвал Кузьмича (шаг 1 разбора «мозг Кузьмича при росте
 * каталога», 29.10): вопросы о турах судятся критериями против эталона,
 * который берётся в момент прогона тем же инструментом get_tours, а не
 * цифрами в фикстуре.
 *
 * Сторож судит поведение: критерии — вызовом судьи на ответах-образцах,
 * прогон — вызовом runKuzmichFaithfulnessEval с подложенными Кузьмичом,
 * судьёй и инструментом, роут — вызовом GET с подложенным прогоном.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  ask: vi.fn(),
  tool: vi.fn(),
  tgSend: vi.fn(async () => ({ ok: true })),
  logAgentRun: vi.fn(async () => undefined),
}));

vi.mock('@/lib/kuzmich/core', () => ({
  askKuzmichForEval: h.ask,
  executeKuzmichTool: h.tool,
}));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: h.tgSend }));
vi.mock('@/lib/agents/run-logger', () => ({ logAgentRun: h.logAgentRun }));
// Судья faithfulness роута — подложен: здесь судятся критерии, а не модель.
vi.mock('@/lib/agents/eval/editor-judge', () => ({ judgeWithFallback: async () => ({ score: 5, reason: 'ok' }) }));

import {
  CommercialCheckSchema,
  commercialRunStatus,
  extractPrices,
  judgeCommercial,
  loadReferences,
  namedTours,
  parseTourLines,
  referenceKey,
  referenceTours,
  summarizeCommercial,
  type CommercialCheck,
  type ReferenceResult,
} from '@/lib/agents/eval/commercial-checks';
import {
  fixtureQuestions,
  runKuzmichFaithfulnessEval,
  commercialFailures,
  decideAlert,
  type EvalQuestion,
} from '@/lib/agents/eval/kuzmich-faithfulness';

// Строки в формате loadTourCatalog (lib/kuzmich/core.ts) — как отдаёт get_tours.
const HEAD = 'РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ (актуальные цены, называй по имени):';
const TAIL = '\nКогда турист спрашивает о конкретном туре — дай факты. Не предлагай оставить заявку первым.';
const T41 = 'ID41: "Вулкан Плоский Толбачик" — Вулкан Плоский Толбачик  тип:trekking 4 дн. от 60 000 ₽/чел. | Оп: Край Вулканов | Расписания в системе нет — четыре дня';
const T73 = 'ID73: "Толбачик: по следам извержений, 4 дня" — Вулкан Плоский Толбачик  тип:volcano 4 дн. от 85 000 ₽/чел. | Оп: Андрей Запорожец | Мест: 4';
const T65 = 'ID65: "Вулкан Толбачик (джип-тур, 4 дня)" — Вулкан Толбачик  тип:jeep_safari 4 дн. от 115 000 ₽/чел. | Оп: Местечко Камчатка | Расписания в системе нет';
const T51 = 'ID51: "Вулкан Толбачик (вертолёт)" — Вулкан Толбачик  тип:helicopter  от 165 000 ₽/чел. | Оп: Местечко Камчатка | Расписания в системе нет';
const T55 = 'ID55: "Облёт Корякского и Авачинского" — Вулканы  тип:helicopter  от 55 000 ₽/чел. | Оп: Местечко Камчатка | Расписания в системе нет';
const T98 = 'ID98: "Облёт вулканов Мутновский и Горелый" — Вулканы  тип:helicopter  от 55 000 ₽/чел. | Оп: Лагуна Экспедиция | Расписания в системе нет';
const T61 = 'ID61: "Вулкан Горелый" — Вулкан Горелый  тип:jeep_safari  от 15 000 ₽/чел. | Оп: Местечко Камчатка | Расписания в системе нет';

const placeText = (place: string, lines: string[]) => [
  HEAD,
  `Туры, где упоминается «${place}» (в названии, месте или описании). Назови их; едет ли тур к самому месту и что там делают, уточни через get_tour_details:`,
  ...lines,
  TAIL,
].join('\n');
const CATALOG = [HEAD, T61, T55, T98, T41, T73, T65, T51, TAIL].join('\n');
const TOLBACHIK = placeText('толбачик', [T41, T73, T65, T51]);
const HELI = [HEAD, T55, T98, T51, TAIL].join('\n');

function refs(entries: Record<string, string>): Map<string, ReferenceResult> {
  const m = new Map<string, ReferenceResult>([[referenceKey(''), { ok: true, text: CATALOG }]]);
  for (const [q, text] of Object.entries(entries)) m.set(referenceKey(q), { ok: true, text });
  return m;
}

const P: CommercialCheck = { kind: 'prices_from_data' };
const O: CommercialCheck = { kind: 'operator_for_each_tour' };
const N = (query: string, max_price?: number): CommercialCheck => ({ kind: 'names_all_tours', query, ...(max_price ? { max_price } : {}) });

function judge(question: string, answer: string, checks: CommercialCheck[], references = refs({ Толбачик: TOLBACHIK }), context = '') {
  return judgeCommercial({ question, answer, context, checks, references });
}
const outcomeOf = (v: ReturnType<typeof judge>, kind: string) => v.checks.find((c) => c.kind === kind);

const FULL_TOLBACHIK = [
  '«Вулкан Плоский Толбачик» от Края Вулканов — от 60 000 ₽.',
  '«Толбачик: по следам извержений, 4 дня» — гид Андрей Запорожец, от 85 000 ₽.',
  '«Вулкан Толбачик (джип-тур, 4 дня)» — Местечко Камчатка, от 115 000 ₽.',
  '«Вулкан Толбачик (вертолёт)» — Местечко Камчатка, от 165 000 ₽.',
].join('\n');

describe('фикстура: вопросы о турах — критерии, а не цифры', () => {
  const commercial = fixtureQuestions('commercial');
  const base = fixtureQuestions('base');

  it('не меньше шестидесяти вопросов о турах, базовые двадцать — без критериев', () => {
    expect(commercial.length).toBeGreaterThanOrEqual(60);
    expect(base).toHaveLength(20);
    expect(base.every((q) => q.checks === undefined && q.category !== 'commercial')).toBe(true);
    expect(commercial.every((q) => q.category === 'commercial' && (q.checks?.length ?? 0) > 0)).toBe(true);
    expect(new Set([...commercial, ...base].map((q) => q.id)).size).toBe(commercial.length + base.length);
  });

  it('покрыт каждый критерий, и цен у каждого вопроса — только из данных', () => {
    const kinds = new Set(commercial.flatMap((q) => q.checks!.map((c) => c.kind)));
    expect([...kinds].sort()).toEqual([
      'names_all_tours', 'only_operator', 'operator_for_each_tour', 'over_budget_flagged',
      'prices_from_data', 'says_not_on_platform',
    ]);
    expect(commercial.every((q) => q.checks!.some((c) => c.kind === 'prices_from_data'))).toBe(true);
  });

  it('есть все роды вопросов из разбора: место, опечатка, бюджет, месяц, компания, несуществующий', () => {
    const ids = commercial.map((q) => q.id);
    for (const prefix of ['place-', 'typo-', 'budget-', 'month-', 'op-', 'none-']) {
      expect(ids.filter((id) => id.startsWith(`commercial-${prefix}`)).length, prefix).toBeGreaterThanOrEqual(5);
    }
    for (const place of ['Толбачик', 'Горелый', 'Курильское']) {
      expect(commercial.some((q) => q.checks!.some((c) => c.kind === 'names_all_tours' && c.query === place)), place).toBe(true);
    }
  });

  it('опечатка — в вопросе, а слово эталона написано верно', () => {
    const typos = commercial.filter((q) => q.id.startsWith('commercial-typo-'));
    for (const q of typos) {
      const ref = q.checks!.find((c) => c.kind === 'names_all_tours');
      if (ref?.kind !== 'names_all_tours') continue;
      expect(q.question.toLowerCase(), q.id).not.toContain(ref.query.toLowerCase());
    }
  });

  it('ни один вопрос не просит заявку: ответ на такое зависит от ещё не принятого решения 2б', () => {
    for (const q of commercial) expect(q.question, q.id).not.toMatch(/заявк|оформ|забронируй/i);
  });

  it('цифра-эталон в критерии до судьи не доходит, а критерий без слова не проходит схему', () => {
    // Лишнее поле Zod срезает: судить по цене из фикстуры нечем.
    const parsed = CommercialCheckSchema.parse({ kind: 'prices_from_data', expected: 60000 });
    expect(parsed).toEqual({ kind: 'prices_from_data' });
    expect(CommercialCheckSchema.safeParse({ kind: 'names_all_tours' }).success).toBe(false);
  });
});

describe('разбор: цены и строки туров', () => {
  it('цена — только число при ₽/руб/тыс/к; километры и годы — не цены', () => {
    expect(extractPrices('от 60 000 ₽, 85 000 руб., 15 тыс. рублей, 50к, 1,5 тыс ₽')).toEqual([60000, 85000, 15000, 50000, 1500]);
    expect(extractPrices('12 км, 2027 год, 4 дня, группа до 4 человек, +7 914 000 00 00')).toEqual([]);
    expect(extractPrices('цена 165 000 ₽')).toEqual([165000]);
  });

  it('строка каталога: id, название, компания, цена', () => {
    expect(parseTourLines(CATALOG).find((t) => t.id === '51')).toEqual({
      id: '51', title: 'Вулкан Толбачик (вертолёт)', operator: 'Местечко Камчатка', price: 165000,
    });
    expect(parseTourLines('ID9: "Без цены" — место тип:x цена не указана').at(0)).toEqual({ id: '9', title: 'Без цены', operator: null, price: null });
  });

  it('эталон: «тип другой» не в нём, ответ «туров нет» — пустой эталон, а не весь каталог', () => {
    expect(referenceTours(TOLBACHIK).map((t) => t.id)).toEqual(['41', '73', '65', '51']);
    const withOther = [HEAD, T55, '', 'Ещё упоминают «вертолет» в названии или описании — тип у них другой, уточни через get_tour_details, прежде чем предлагать:', T65, TAIL].join('\n');
    expect(referenceTours(withOther).map((t) => t.id)).toEqual(['55']);
    expect(referenceTours(`Туров «дайвинг» у операторов платформы сейчас нет — ни по типу, ни в описаниях. Не выдавай другие туры за такие. Весь каталог — для замены с явной оговоркой:\n${CATALOG}`)).toEqual([]);
    expect(referenceTours(`Тура с типом «рыбалка» нет. Упоминают «рыбалка» в названии или описании — тип у них другой, уточни через get_tour_details, прежде чем предлагать:\n${T41}`)).toEqual([]);
  });

  it('тур узнан по названию или по цене, которая у него одна', () => {
    const universe = parseTourLines(CATALOG);
    const ids = (a: string) => namedTours(a, universe).map((t) => t.id).sort();
    expect(ids('Вулкан Толбачик (вертолёт) — дорого')).toEqual(['51']);
    expect(ids('Вертолётом на Толбачик — 165 000 ₽')).toEqual(['51']);
    // 55 000 — у двух туров: по цене не узнаётся ни один.
    expect(ids('облёт за 55 000 ₽')).toEqual([]);
    // Слово «Толбачик» в тексте не делает названным тур «Вулкан Толбачик (вертолёт)».
    expect(ids('На Толбачик можно поехать.')).toEqual([]);
  });
});

describe('судья критериев', () => {
  it('все туры к месту с компаниями и ценами из данных — проходит', () => {
    const v = judge('Какие туры есть на Толбачик?', FULL_TOLBACHIK, [N('Толбачик'), O, P]);
    expect(v.outcome).toBe('pass');
  });

  it('пропущен один тур — провал с номером пропущенного', () => {
    const answer = FULL_TOLBACHIK.split('\n').slice(0, 3).join('\n');
    const v = judge('Какие туры есть на Толбачик?', answer, [N('Толбачик')]);
    expect(v.outcome).toBe('fail');
    expect(outcomeOf(v, 'names_all_tours')?.reason).toContain('нет ID51');
  });

  it('у тура не названа компания — провал', () => {
    const v = judge('q', '«Вулкан Толбачик (вертолёт)» — от 165 000 ₽. «Вулкан Плоский Толбачик» от Края Вулканов — 60 000 ₽.', [O]);
    expect(outcomeOf(v, 'operator_for_each_tour')).toMatchObject({ outcome: 'fail' });
    expect(outcomeOf(v, 'operator_for_each_tour')?.reason).toContain('ID51 (Местечко Камчатка)');
  });

  it('компания в другом падеже — названа', () => {
    const v = judge('q', 'У Лагуны Экспедиции — «Облёт вулканов Мутновский и Горелый».', [O]);
    expect(outcomeOf(v, 'operator_for_each_tour')?.outcome).toBe('pass');
  });

  it('ни один тур не узнан — компания «не смог проверить», а не «прошёл»', () => {
    expect(outcomeOf(judge('q', 'Туров много, спросите оператора.', [O]), 'operator_for_each_tour')?.outcome).toBe('unknown');
  });

  it('выдуманная цена — провал; цена на двоих и бюджет из вопроса — из данных', () => {
    expect(outcomeOf(judge('q', '«Вулкан Плоский Толбачик» — 58 000 ₽', [P]), 'prices_from_data'))
      .toMatchObject({ outcome: 'fail', reason: 'цены не из данных: 58000' });
    expect(judge('Толбачик на двоих', 'Плоский Толбачик: 60 000 ₽ с человека, на двоих 120 000 ₽.', [P]).outcome).toBe('pass');
    expect(judge('Есть тур дешевле 70 000?', 'До 70 000 ₽ — только Плоский Толбачик за 60 000 ₽.', [P]).outcome).toBe('pass');
    // Цена из вывода инструмента хода — тоже данные.
    expect(judge('q', 'Номер — 4 500 ₽ за ночь.', [P], refs({}), '[инструмент search_accommodations]\nКутха: от 4 500 ₽')).toMatchObject({ outcome: 'pass' });
  });

  it('каталог не прочитан — непроверенная цена не объявляется выдумкой', () => {
    const r = new Map<string, ReferenceResult>([[referenceKey(''), { ok: false, reason: 'get_tours «весь каталог» не выполнился' }]]);
    expect(outcomeOf(judge('q', 'Тур стоит 58 000 ₽', [P], r), 'prices_from_data')?.outcome).toBe('unknown');
  });

  it('несуществующий тур: честное «нет на платформе» проходит, выдумка — нет', () => {
    const S: CommercialCheck = { kind: 'says_not_on_platform' };
    expect(judge('Тур на Луну?', 'Такого тура на платформе нет.', [S]).outcome).toBe('pass');
    expect(judge('Тур на Луну?', 'Не нашёл такой тур в каталоге Ведара.', [S]).outcome).toBe('pass');
    expect(judge('Тур на Луну?', 'Тур на Луну стоит 1 000 000 ₽, отличный выбор!', [S, P]).outcome).toBe('fail');
  });

  it('что есть у компании: чужой тур под её именем — провал; компании нет на витрине — «не смог»', () => {
    const OO = (operator: string): CommercialCheck => ({ kind: 'only_operator', operator });
    expect(judge('q', 'У Местечка: «Вулкан Горелый» и «Вулкан Толбачик (вертолёт)».', [OO('Местечко Камчатка')]).outcome).toBe('pass');
    const foreign = judge('q', 'У Местечка: «Вулкан Горелый» и «Вулкан Плоский Толбачик».', [OO('Местечко Камчатка')]);
    expect(foreign.outcome).toBe('fail');
    expect(foreign.checks[0].reason).toContain('ID41 (Край Вулканов)');
    expect(judge('q', 'Ничего не нашёл.', [OO('Местечко Камчатка')]).outcome).toBe('fail');
    expect(judge('q', 'что-то', [OO('Вулкан-Тревел Плюс')]).outcome).toBe('unknown');
  });

  it('вид + бюджет: назвать все в бюджете; дороже бюджета — только с оговоркой', () => {
    const r = refs({ вертолет: HELI });
    const checks = [N('вертолет', 60_000), { kind: 'over_budget_flagged', max_price: 60_000 } as CommercialCheck];
    const both = '«Облёт Корякского и Авачинского» (Местечко Камчатка) и «Облёт вулканов Мутновский и Горелый» (Лагуна Экспедиция) — по 55 000 ₽.';
    expect(judge('Вертолёт до 60 000', both, checks, r).outcome).toBe('pass');
    expect(judge('Вертолёт до 60 000', `${both} Ещё «Вулкан Толбачик (вертолёт)» за 165 000 ₽.`, checks, r).outcome).toBe('fail');
    expect(judge('Вертолёт до 60 000', `${both} «Вулкан Толбачик (вертолёт)» — дороже бюджета, 165 000 ₽.`, checks, r).outcome).toBe('pass');
  });

  it('в бюджет ничего: честное «нет» проходит, молчание о бюджете — провал', () => {
    const r = refs({ вертолет: HELI });
    const checks = [N('вертолет', 50_000)];
    expect(judge('Вертолёт до 50 000', 'Вертолётных туров до 50 000 ₽ на платформе нет; самый доступный — 55 000 ₽.', checks, r).outcome).toBe('pass');
    expect(judge('Вертолёт до 50 000', 'Берите облёт за 55 000 ₽ — лучший вариант.', checks, r).outcome).toBe('fail');
  });

  it('эталон пуст или не прочитан — «не смог проверить», а не «прошёл»', () => {
    const empty = refs({ дайвинг: `Туров «дайвинг» у операторов платформы сейчас нет — ни по типу, ни в описаниях. Не выдавай другие туры за такие. Весь каталог — для замены с явной оговоркой:\n${CATALOG}` });
    expect(judge('q', 'что-то', [N('дайвинг')], empty).outcome).toBe('unknown');
    const failed = new Map<string, ReferenceResult>([[referenceKey('Толбачик'), { ok: false, reason: 'get_tours «Толбачик» не выполнился' }]]);
    expect(judge('q', FULL_TOLBACHIK, [N('Толбачик')], failed)).toMatchObject({ outcome: 'unknown' });
  });

  it('провал перевешивает «не смог», «не смог» — успех', () => {
    expect(judge('q', 'Тур стоит 58 000 ₽.', [P, O]).outcome).toBe('fail');
    expect(judge('q', 'Ничего конкретного.', [P, O]).outcome).toBe('unknown');
  });
});

describe('эталоны: тот же инструмент, отказ назван', () => {
  it('весь каталог и по слову каждого критерия', async () => {
    const tool = vi.fn(async (_n: string, args: Record<string, string>) => (args.activity_type ? TOLBACHIK : CATALOG));
    const r = await loadReferences([N('Толбачик'), P], tool);
    expect(tool.mock.calls).toEqual([['get_tours', {}], ['get_tours', { activity_type: 'Толбачик' }]]);
    expect(r.get(referenceKey('Толбачик'))).toEqual({ ok: true, text: TOLBACHIK });
  });

  it('отказ инструмента — ok:false с причиной и строка в лог с SQLSTATE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tool = vi.fn(async (_n: string, args: Record<string, string>) => {
      if (args.activity_type) throw Object.assign(new Error('boom'), { code: '57014' });
      return 'Ошибка при выполнении запроса.';
    });
    const r = await loadReferences([N('Толбачик')], tool);
    expect(r.get(referenceKey(''))).toMatchObject({ ok: false });
    expect(r.get(referenceKey('Толбачик'))).toMatchObject({ ok: false });
    expect(err).toHaveBeenCalledWith('[commercial-eval] эталон get_tours не прочитан', expect.objectContaining({ sqlstate: '57014', query: 'Толбачик' }));
    err.mockRestore();
  });
});

describe('прогон: критерии едут в отчёт рядом с faithfulness', () => {
  beforeEach(() => {
    h.ask.mockReset();
    h.tool.mockReset();
    h.tgSend.mockClear();
  });

  const questions: EvalQuestion[] = [
    { id: 'c1', category: 'commercial', question: 'Какие туры есть на Толбачик?', checks: [N('Толбачик'), O, P] },
    { id: 'c2', category: 'commercial', question: 'Есть тур на Луну?', checks: [{ kind: 'says_not_on_platform' }, P] },
    { id: 'c3', category: 'commercial', question: 'Туры на Горелый?', checks: [O, P] },
  ];

  it('эталон берёт инструмент Кузьмича; сводка считает «не смог» отдельно от провала', async () => {
    h.tool.mockImplementation(async (_n: string, args: Record<string, string>) => (args.activity_type ? TOLBACHIK : CATALOG));
    h.ask.mockImplementation(async (q: string) => {
      if (q.includes('Толбачик')) return { answer: FULL_TOLBACHIK, context: '' };
      if (q.includes('Луну')) return { answer: 'Тур на Луну стоит 999 000 ₽.', context: '' };
      return null; // Кузьмич не ответил
    });
    const judgeFn = vi.fn(async () => ({ score: 5, reason: 'ok' }));
    const report = await runKuzmichFaithfulnessEval({ questions, deps: { judge: judgeFn } });

    expect(h.tool).toHaveBeenCalledWith('get_tours', { activity_type: 'Толбачик' });
    expect(report.cases.map((c) => c.commercial?.outcome)).toEqual(['pass', 'fail', 'unknown']);
    expect(report.commercial).toMatchObject({ asked: 3, judged: 2, passed: 1, unknown: 1, pass_rate: 0.5 });
    expect(report.commercial?.by_kind.says_not_on_platform).toEqual({ pass: 0, fail: 1, unknown: 0 });
    // Судья faithfulness — для ответивших, критерии его не заменяют.
    expect(judgeFn).toHaveBeenCalledTimes(2);
    expect(commercialFailures(report.cases).map((f) => [f.id, f.outcome])).toEqual([['c2', 'fail'], ['c3', 'unknown']]);
    expect(report.pass_rate).toBe(1);
    // Тревога называет набор: два понедельничных прогона не сливаются в один заголовок.
    const low = { ...report, pass_rate: 0.5, judge_unavailable_ratio: 0 };
    expect(decideAlert(low)).toContain('<b>Kuzmich Eval (вопросы о турах): faithfulness');
    expect(decideAlert({ ...low, commercial: null })).toContain('<b>Kuzmich Eval: faithfulness');
  });

  it('базовый прогон без критериев — сводки критериев нет вовсе', async () => {
    h.ask.mockResolvedValue({ answer: 'ответ', context: 'контекст' });
    const report = await runKuzmichFaithfulnessEval({
      questions: [{ id: 'b', category: 'route', question: 'Маршрут на Авачинский?' }],
      deps: { judge: async () => ({ score: 5, reason: 'ok' }) },
    });
    expect(report.commercial).toBeNull();
    expect(h.tool).not.toHaveBeenCalled();
  });

  it('исход прогона по критериям: ничего не судилось — «не смог», ниже порога — провал', () => {
    expect(commercialRunStatus(null)).toEqual({ status: 'partial', skip_reason: 'commercial_unjudged' });
    expect(commercialRunStatus(summarizeCommercial([{ outcome: 'unknown', checks: [] }])))
      .toEqual({ status: 'partial', skip_reason: 'commercial_unjudged' });
    expect(commercialRunStatus(summarizeCommercial([{ outcome: 'pass', checks: [] }, { outcome: 'fail', checks: [] }])))
      .toEqual({ status: 'failed', skip_reason: 'commercial_below_threshold' });
    expect(commercialRunStatus(summarizeCommercial([{ outcome: 'pass', checks: [] }]))).toEqual({ status: 'success', skip_reason: null });
  });
});

describe('роут: ?set=commercial — свой набор и своё имя в журнале', () => {
  it('базовый прогон спрашивает двадцать базовых, коммерческий — вопросы о турах', async () => {
    process.env.CRON_SECRET = 'test-secret';
    h.ask.mockResolvedValue({ answer: 'Такого тура на платформе нет.', context: '' });
    h.tool.mockResolvedValue(CATALOG);
    h.logAgentRun.mockClear();
    const { GET } = await import('@/app/api/cron/kuzmich-eval/route');
    const { NextRequest } = await import('next/server');
    const call = (q: string) => GET(new NextRequest(`http://localhost/api/cron/kuzmich-eval${q}`, {
      headers: { authorization: 'Bearer test-secret' },
    }));

    const base = await (await call('')).json() as { set: string; asked: number; commercial: unknown };
    expect(base).toMatchObject({ set: 'base', asked: 20, commercial: null });

    const res = await call('?set=commercial');
    const body = await res.json() as { set: string; asked: number; commercial: { asked: number } };
    expect(body.set).toBe('commercial');
    expect(body.asked).toBe(fixtureQuestions('commercial').length);
    expect(body.commercial.asked).toBe(body.asked);

    const names = h.logAgentRun.mock.calls.map((c) => (c as unknown as [{ agent_id: string; metadata: { skip_reason: string | null } }])[0]);
    expect(names.map((n) => n.agent_id)).toEqual(['kuzmich-eval', 'kuzmich-eval-commercial']);
    // Ответ «нет на платформе» на все вопросы: «назвать все туры» проваливается —
    // исход прогона берётся из критериев, а не из судьи (он поставил 5 всем).
    expect(names[1].metadata.skip_reason).toBe('commercial_below_threshold');
  }, 30_000);
});
