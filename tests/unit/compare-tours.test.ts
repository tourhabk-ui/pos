/**
 * compare_tours — 2–4 тура рядом фактами из базы (слово владельца 29.10).
 *
 * Сторож держит правило поведением, а не текстом исходника:
 *   - вход: сколько туров названо, синонимы критериев, неизвестное — названо;
 *   - сборка ответа на граничных данных: нет цены, нет условий отмены, одно
 *     число условий из двух, нет программы, разные единицы цены, «не записано»
 *     против значения — третий исход, а не «отличается»; порядок туров — как у
 *     человека; ни одного слова оценки;
 *   - исполнитель с подменённым резолвером и базой: повтор тура, неоднозначное
 *     имя, тур не с витрины, итог за людей тем же расчётом на названную дату;
 *   - объявление: реестр MCP, аннотация «только чтение», потолок журнала.
 * Настоящая база — сцена «девять туров трёх компаний» в
 * tests/integration/public-tour-gate.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQuery, resolveMock, groupTotalMock, slotMock } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  resolveMock: vi.fn(),
  groupTotalMock: vi.fn(),
  slotMock: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/seat-requests/core', async (orig) => ({
  ...(await orig<typeof import('@/lib/seat-requests/core')>()),
  kamchatkaToday: () => '2026-10-30',
}));
vi.mock('@/lib/kuzmich/tour-availability-tool', async (orig) => ({
  ...(await orig<typeof import('@/lib/kuzmich/tour-availability-tool')>()),
  resolveTourChoice: resolveMock,
  groupTotalOn: groupTotalMock,
  nearestSlotFor: slotMock,
}));

import { splitTourList, parseCriteria, DEFAULT_CRITERIA, type Criterion } from '@/lib/tours/compare-input';
import { renderComparison, type CompareRow, type CompareTourFacts } from '@/lib/tours/compare-render';
import { compareToursForKuzmich } from '@/lib/kuzmich/tour-compare-tool';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';
import { journalToolOutput } from '@/lib/kuzmich/core';
import { localizeToolArgs } from '@/lib/mcp/query-lang';

/** Слова оценки и ранга: в сравнении их нет никогда (запрет — регуляркой, §13.10). */
const RANK_WORDS = /лучш|хуже|дешевл|дороже|выгодн|рекоменд|оптимал|идеал|победител|балл|рейтинг|мест[оа] ?№? ?1\b|топ[- ]?\d/i;
/** Ноль рублей там, где цены нет: «0 ₽» без цифры или разряда перед нулём. */
const ZERO_RUB = /(^|[^\d ])0 ₽/m;

const TODAY = '2026-10-30';
const BASE = 'https://vedarai.ru';

function facts(over: Partial<CompareTourFacts> = {}): CompareTourFacts {
  return {
    id: 901, title: 'Вулкан Пробный (джип)', slug: 'alfa-probnyj',
    base_price: 15000, price_unit: 'per_person',
    duration_type: null, multi_day_count: null, duration_hours: 10, difficulty: 'easy',
    season_start: '2027-07-15', season_end: '2027-10-15',
    max_participants: 8, group_size_unlimited: false,
    program: [{ title: 'Дорога к вулкану', text: 'Выезд утром.' }, { title: 'Восхождение', text: 'Три часа.' }],
    included: ['трансфер', 'обед'], not_included: ['страховка'],
    cancellation_policy: 'Бесплатная отмена за 3 дня до тура.', cancellation_free_days: 3, cancellation_late_refund_percent: 50,
    pickup_type: 'hotel_pickup', pickup_details: 'Из гостиниц Петропавловска.', meeting_point: null,
    operator_id: 'op-alfa', operator_name: 'Компания Альфа', operator_verified: true,
    operator_slug: 'alfa', operator_public: true,
    operator_legal_name: 'ООО «Альфа»', operator_inn: '4100000000', operator_ogrn: null,
    nearest_free_date: '2027-07-19', keeps_schedule: true,
    ...over,
  };
}

const ALFA = facts();
const BETA = facts({
  id: 902, title: 'Восхождение на Пробный', slug: 'beta-probnyj', base_price: 18000,
  duration_hours: 12, difficulty: 'medium', program: null, included: null, not_included: null,
  cancellation_policy: null, cancellation_free_days: null, cancellation_late_refund_percent: null,
  pickup_type: null, pickup_details: null, operator_id: 'op-beta', operator_name: 'Гид Бета',
  operator_verified: false, operator_slug: null, operator_public: null,
  operator_legal_name: null, operator_inn: null, nearest_free_date: null, keeps_schedule: false,
});

function render(rows: CompareRow[], criteria: readonly Criterion[], people: number | null = null): string {
  return renderComparison({ rows, criteria, people, today: TODAY, base: BASE, notes: [], unknown: [], defaulted: false });
}

/** Строки одной секции (заголовок — первая строка блока). */
function sectionOf(text: string, heading: string): string {
  const block = text.split('\n\n').find((b) => b.startsWith(heading));
  if (!block) throw new Error(`секции «${heading}» нет:\n${text}`);
  return block;
}

const ALL = [
  'price', 'duration', 'group', 'difficulty', 'season', 'program', 'included', 'not_included',
  'cancellation', 'pickup', 'operator', 'nearest_date',
] as const satisfies readonly Criterion[];

describe('вход: туры', () => {
  it('номера через запятую, «ID» и «tour:», массив через схему', () => {
    expect(splitTourList('61, 70')).toEqual(['61', '70']);
    expect(splitTourList('ID61; tour:70')).toEqual(['61', '70']);
    expect(splitTourList('61 и 70')).toEqual(['61', '70']);
    expect(splitTourList('1,2,3,4,5')).toHaveLength(5);
  });

  it('строка не из номеров без «;» — одно название: запятая в названии не угадывается', () => {
    expect(splitTourList('Вулкан Горелый, кратеры и пещеры')).toEqual(['Вулкан Горелый, кратеры и пещеры']);
    expect(splitTourList('Горелый; Мутновский')).toEqual(['Горелый', 'Мутновский']);
  });

  it('схема: 2 и 4 тура — да, 1 и 5 — отказ словами; массив и tour_ids принимаются', () => {
    expect(validateToolArgs('compare_tours', { tours: '61, 70' })).toEqual({ ok: true, args: { tours: '61, 70' } });
    expect(validateToolArgs('compare_tours', { tours: '1, 2, 3, 4' }).ok).toBe(true);
    const one = validateToolArgs('compare_tours', { tours: '61' });
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.error).toMatch(/назван один тур — для сравнения нужно 2–4/);
    const five = validateToolArgs('compare_tours', { tours: '1,2,3,4,5' });
    expect(five.ok).toBe(false);
    if (!five.ok) expect(five.error).toMatch(/не больше 4 туров/);
    expect(validateToolArgs('compare_tours', { tours: [61, 70] } as unknown as Record<string, string>))
      .toEqual({ ok: true, args: { tours: '61; 70' } });
    expect(validateToolArgs('compare_tours', { tour_ids: '61,70', people: 2 } as unknown as Record<string, string>))
      .toEqual({ ok: true, args: { tours: '61,70', people: '2' } });
    expect(validateToolArgs('compare_tours', {}).ok).toBe(false);
  });

  it('китайский список через «；» переводится по одному и не сливается в одно название', () => {
    const l = localizeToolArgs('compare_tours', { tours: '阿瓦恰火山；穆特诺夫斯基' });
    expect(l.lang).toBe('zh');
    expect(splitTourList(String(l.args.tours))).toEqual(['Авачинский', 'Мутновский']);
  });
});

describe('вход: критерии', () => {
  it('синонимы по-русски и по-английски — в порядке, как назвал человек', () => {
    expect(parseCriteria('стоимость, refund, как добраться').keys).toEqual(['price', 'cancellation', 'pickup']);
    expect(parseCriteria('как добраться, стоимость').keys).toEqual(['pickup', 'price']);
    expect(parseCriteria('что входит и не входит').keys).toEqual(['included', 'not_included']);
    expect(parseCriteria('условия отмены и возврата').keys).toEqual(['cancellation']);
  });

  it('неизвестное называется с причиной, а не выбрасывается; ничего не узнано — короткий набор', () => {
    const r = parseCriteria('рейтинг');
    expect(r.unknown).toEqual([{ word: 'рейтинг', why: expect.stringMatching(/оценок сравнение не ставит/) }]);
    expect(r.defaulted).toBe(true);
    expect(r.keys).toEqual([...DEFAULT_CRITERIA]);
    expect(parseCriteria('цена, погода у кратера').unknown.map((u) => u.word)).toEqual(['погода у кратера']);
    expect(parseCriteria('').defaulted).toBe(true);
  });
});

describe('сборка ответа: факты рядом, без оценки', () => {
  it('порядок туров — как во входе: меняем местами — меняется ответ', () => {
    const ab = render([{ facts: ALFA }, { facts: BETA }], ['price']);
    const ba = render([{ facts: BETA }, { facts: ALFA }], ['price']);
    expect(ab.indexOf('1. ID901')).toBeGreaterThan(-1);
    expect(ba.indexOf('1. ID902')).toBeGreaterThan(-1);
    const priceBa = sectionOf(ba, 'Цена');
    expect(priceBa.indexOf('ID902:')).toBeLessThan(priceBa.indexOf('ID901:'));
  });

  it('строки — в порядке критериев человека', () => {
    const t = render([{ facts: ALFA }, { facts: BETA }], ['operator', 'price']);
    expect(t.indexOf('Оператор и проверка')).toBeLessThan(t.indexOf('\nЦена'));
  });

  it('ни одного слова оценки при разных ценах, сложности и операторах', () => {
    const t = render([{ facts: ALFA }, { facts: BETA }], ALL);
    expect(t).not.toMatch(RANK_WORDS);
    const g = render(
      [{ facts: ALFA, groupSlot: { state: 'found', date: '2027-07-19', remaining: 4 }, groupPrice: { kind: 'on', date: '2027-07-19', basis: 'slot', total: { kind: 'total', total: 30000 } } },
        { facts: BETA, groupPrice: { kind: 'on', date: '2027-07-15', basis: 'request', total: { kind: 'total', total: 36000 } } }],
      ALL, 2,
    );
    expect(g).not.toMatch(RANK_WORDS);
  });

  it('тур без цены — «цена не указана», а не ноль', () => {
    const t = render([{ facts: ALFA }, { facts: facts({ id: 903, base_price: null }) }], ['price']);
    expect(t).toContain('ID903: цена не указана');
    expect(t).not.toMatch(ZERO_RUB);
    expect(sectionOf(t, 'Цена')).toMatch(/^Цена — не сравнить: у ID903 цена не указана/);
    const g = render([{ facts: ALFA, groupPrice: { kind: 'on', date: '2027-07-19', basis: 'slot', total: { kind: 'total', total: 30000 } } },
      { facts: facts({ id: 903, base_price: null }), groupPrice: { kind: 'no_price' } }], ['price'], 2);
    expect(g).toContain('ID903: цена не указана — итог назовёт оператор');
    expect(g).not.toMatch(ZERO_RUB);
  });

  it('итог за людей называет дату и основание даты', () => {
    const t = render([
      { facts: ALFA, groupPrice: { kind: 'on', date: '2027-07-19', basis: 'slot', total: { kind: 'total', total: 30000 } } },
      { facts: BETA, groupPrice: { kind: 'on', date: '2027-07-15', basis: 'request', total: { kind: 'tier_miss' } } },
    ], ['price'], 2);
    expect(t).toContain('ID901: итого за 2 чел.: 30 000 ₽ — на 19 июля 2027 (первая дата, где мест хватит на 2 чел.); цена тура — от 15 000 ₽/чел.');
    expect(t).toContain('ID902: для группы из 2 чел. цену называет оператор');
    expect(sectionOf(t, 'Цена за 2 чел.')).toMatch(/— не сравнить: у ID902 цену называет оператор/);
  });

  it('условий отмены нет — «не записаны», без обещания вернуть всю сумму', () => {
    const t = render([{ facts: ALFA }, { facts: BETA }], ['cancellation']);
    expect(t).toContain('ID902: условия отмены не записаны — уточняется у оператора; не называй сроков и процентов');
    expect(t).not.toMatch(/вернём всю сумму/);
    expect(t).toContain('ID901: текст тура: «Бесплатная отмена за 3 дня до тура.»; числами: Бесплатная отмена не позднее чем за 3 дня до тура, позже возвращается 50%.');
  });

  it('одно число условий из двух — не досчитывается', () => {
    const half = facts({ id: 904, cancellation_late_refund_percent: null });
    const t = render([{ facts: half }, { facts: ALFA }], ['cancellation']);
    const line = t.split('\n').find((l) => l.startsWith('- ID904:')) ?? '';
    expect(line).not.toMatch(/Бесплатная отмена не позднее/);
    expect(line).toMatch(/числами записаны не полностью — не досчитывай/);
    const onlyDays = facts({ id: 905, cancellation_policy: null, cancellation_late_refund_percent: null });
    expect(render([{ facts: onlyDays }, { facts: ALFA }], ['cancellation'])).toMatch(/ID905: условия отмены не записаны.*не полностью/);
  });

  it('нет программы и списков — «не записано», а не пустота', () => {
    const t = render([{ facts: ALFA }, { facts: BETA }], ['program', 'included']);
    expect(t).toContain('ID902: программа по дням не записана — уточняется у оператора');
    expect(t).toContain('ID901: записана: 2 пункта — Дорога к вулкану; Восхождение');
    expect(sectionOf(t, 'Что входит')).toMatch(/^Что входит — не сравнить: у ID902 не записано, что входит/);
  });

  it('цена за человека против цены за группу — «не сравнить напрямую»', () => {
    const t = render([{ facts: ALFA }, { facts: facts({ id: 906, price_unit: 'per_tour', base_price: 60000 }) }], ['price']);
    expect(sectionOf(t, 'Цена')).toMatch(/^Цена — не сравнить напрямую: цена назначена за разное — ID901 за человека; ID906 за группу/);
    // Итоги за группу сравнимы при любых единицах.
    const g = render([
      { facts: ALFA, groupPrice: { kind: 'on', date: '2027-07-19', basis: 'slot', total: { kind: 'total', total: 30000 } } },
      { facts: facts({ id: 906, price_unit: 'per_tour', base_price: 60000 }), groupPrice: { kind: 'on', date: '2027-07-15', basis: 'request', total: { kind: 'total', total: 60000 } } },
    ], ['price'], 2);
    expect(sectionOf(g, 'Цена за 2 чел.')).toMatch(/ — отличается$/m);
  });

  it('отметки: одинаково, отличается и третий исход, когда у кого-то не записано', () => {
    const same = render([{ facts: ALFA }, { facts: facts({ id: 907 }) }], ['duration']);
    expect(sectionOf(same, 'Длительность').split('\n')[0]).toBe('Длительность — одинаково');
    const diff = render([{ facts: ALFA }, { facts: BETA }], ['duration']);
    expect(sectionOf(diff, 'Длительность').split('\n')[0]).toBe('Длительность — отличается');
    const gap = render([{ facts: ALFA }, { facts: facts({ id: 908, duration_hours: null }) }], ['duration']);
    expect(sectionOf(gap, 'Длительность').split('\n')[0]).toBe('Длительность — не сравнить: у ID908 длительность не записана');
    expect(gap).toContain('ID908: не записана');
  });

  it('оператор: проверка словами из partners.is_verified, реквизиты — из legal_info', () => {
    const t = render([{ facts: ALFA }, { facts: BETA }, { facts: facts({ id: 909, operator_id: 'op-g', operator_verified: null }) }], ['operator']);
    expect(t).toContain('ID901: Компания Альфа — проверен платформой; исполнитель: ООО «Альфа», ИНН 4100000000; страница: https://vedarai.ru/operators/alfa');
    expect(t).toContain('ID902: Гид Бета — отметки «проверен платформой» нет; исполнитель: реквизиты на платформе не записаны');
    expect(t).toContain('ID909: Компания Альфа — проверка не записана');
    expect(sectionOf(t, 'Оператор и проверка').split('\n')[0]).toBe('Оператор и проверка — разные операторы');
  });

  it('группа: «не ограничена» только по признаку 1342, иначе предел не выдаётся за факт', () => {
    const t = render([{ facts: facts({ group_size_unlimited: true, max_participants: 20 }) }, { facts: BETA }], ['group']);
    expect(t).toContain('ID901: Группа не ограничена (одна заявка на сайте — до 12 человек)');
    expect(t).toContain('ID902: предел группы как факт о туре не отмечен; одна заявка на сайте — до 8 чел. (потолок заявки, а не обязательно предел группы)');
    expect(sectionOf(t, 'Группа').split('\n')[0]).toBe('Группа — не сравнить: у ID902 предел группы не отмечен');
    expect(t).not.toMatch(/Группа до 8/);
  });

  it('ближайшая дата: календарь, заявка без календаря и дата на группу', () => {
    const t = render([{ facts: ALFA }, { facts: BETA }], ['nearest_date']);
    expect(t).toContain('ID901: ближайшая дата со свободными местами — 19 июля 2027');
    expect(t).toContain('ID902: даты по заявке, сезон 15 июля 2027 — 15 октября 2027; числа мест нет, дату подтверждает оператор');
    const g = render([{ facts: ALFA, groupSlot: { state: 'none' } }, { facts: BETA }], ['nearest_date'], 5);
    expect(g).toContain('ID901: в пределах года нет даты, где мест хватит на 5 чел.');
    const f = render([{ facts: ALFA, groupSlot: { state: 'failed' } }, { facts: BETA }], ['nearest_date'], 2);
    expect(f).toContain('ID901: даты не загрузились — не говори, что дат нет');
  });
});

describe('исполнитель: резолвер, витрина, повтор, итог за людей', () => {
  const candidate = (f: CompareTourFacts) => ({
    id: f.id, title: f.title, operator_id: f.operator_id, slug: f.slug, base_price: f.base_price, price_unit: f.price_unit,
    multi_day_count: f.multi_day_count, duration_hours: f.duration_hours, duration_type: f.duration_type,
    season_start: f.season_start, season_end: f.season_end, operator_name: f.operator_name,
    main_place_id: null, place: null, nearest_free_date: f.nearest_free_date,
  });
  const byRef: Record<string, unknown> = {};

  beforeEach(() => {
    poolQuery.mockReset();
    resolveMock.mockReset();
    groupTotalMock.mockReset();
    slotMock.mockReset();
    for (const k of Object.keys(byRef)) delete byRef[k];
    byRef['901'] = { kind: 'one', tour: candidate(ALFA) };
    byRef['902'] = { kind: 'one', tour: candidate(BETA) };
    byRef['Вулкан Пробный (джип)'] = { kind: 'one', tour: candidate(ALFA) };
    byRef['Пробный'] = { kind: 'ambiguous', candidates: [candidate(ALFA), candidate(BETA)] };
    resolveMock.mockImplementation(async (ref: string) => byRef[ref] ?? { kind: 'none' });
    // База отдаёт строки в своём порядке — не в порядке человека.
    poolQuery.mockImplementation(async (_sql: string, params: unknown[]) => ({
      rows: [ALFA, BETA].filter((f) => (params[0] as number[]).includes(f.id)),
    }));
  });

  it('туры — в порядке человека, а не базы; запрос фактов несёт шлюз витрины', async () => {
    const t = await compareToursForKuzmich({ tours: '902, 901', criteria: 'цена' });
    expect(t.indexOf('1. ID902')).toBeGreaterThan(-1);
    expect(t.indexOf('2. ID901')).toBeGreaterThan(-1);
    const sql = String(poolQuery.mock.calls[0][0]);
    expect(sql).toMatch(/is_published = true/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  it('один тур дважды — один раз и с объяснением', async () => {
    const t = await compareToursForKuzmich({ tours: '901; Вулкан Пробный (джип); 902' });
    expect(t).toContain('«Вулкан Пробный (джип)» и «901» — один и тот же тур ID901; в сравнении он один раз.');
    expect(t.match(/^\d\. ID901/gm)).toHaveLength(1);
    const twice = await compareToursForKuzmich({ tours: '901; ID901' });
    expect(twice).toMatch(/^Сравнивать нечего: на витрине из названных остался один тур \(ID901\)/);
  });

  it('неоднозначное имя — сравнения нет, в ответе номера туров обеих компаний', async () => {
    const t = await compareToursForKuzmich({ tours: 'Пробный; 901' });
    expect(t).toMatch(/^По запросу «Пробный» подходят туры разных компаний — сравнение не собрано/);
    expect(t).toContain('- ID901 «Вулкан Пробный (джип)» — Компания Альфа');
    expect(t).toContain('- ID902 «Восхождение на Пробный» — Гид Бета');
    expect(t).not.toMatch(/^Цена/m);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('тур не на витрине назван словами соседей и не сравнивается', async () => {
    const t = await compareToursForKuzmich({ tours: '901, 7, 902' });
    expect(t).toContain('Тур по запросу "7" не найден среди активных — в сравнение не взят.');
    expect(t).toMatch(/^Сравнение 2 туров/);
    // Резолвер нашёл, а витрина между резолвом и чтением фактов тур убрала.
    byRef['903'] = { kind: 'one', tour: candidate(facts({ id: 903 })) };
    const gone = await compareToursForKuzmich({ tours: '901, 903' });
    expect(gone).toMatch(/^Сравнивать нечего/);
    expect(gone).toContain('Тур по запросу "903" не найден среди активных — в сравнение не взят.');
  });

  it('пять туров и один — отказ, без запроса в базу', async () => {
    expect(await compareToursForKuzmich({ tours: '1,2,3,4,5' })).toMatch(/не больше 4 туров/);
    expect(await compareToursForKuzmich({ tours: '901' })).toMatch(/назван один тур/);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('итог за людей — groupTotalOn на первую дату, где мест хватит; без расписания — на первую дату окна', async () => {
    slotMock.mockResolvedValue({ state: 'found', date: '2027-07-19', remaining: 4 });
    groupTotalMock.mockImplementation(async (tour: { id: number }) => ({ kind: 'total', total: tour.id === 901 ? 3000 : 36000 }));
    const t = await compareToursForKuzmich({ tours: '901, 902', criteria: 'цена, ближайшая дата', people: '2' });
    expect(slotMock).toHaveBeenCalledWith(901, 2, TODAY);
    expect(slotMock).toHaveBeenCalledTimes(1);
    expect(groupTotalMock).toHaveBeenCalledWith(expect.objectContaining({ id: 901 }), '2027-07-19', 2);
    expect(groupTotalMock).toHaveBeenCalledWith(expect.objectContaining({ id: 902 }), '2027-07-15', 2);
    expect(t).toContain('ID901: итого за 2 чел.: 3 000 ₽ — на 19 июля 2027 (первая дата, где мест хватит на 2 чел.)');
    expect(t).toContain('ID902: итого за 2 чел.: 36 000 ₽ — на 15 июля 2027 (первая дата для заявки; расписания нет)');
    expect(t).toContain('ID901: 19 июля 2027, свободно 4 — мест хватит на 2 чел.');
  });

  it('число людей не распознано — сказано, итог не считается', async () => {
    const t = await compareToursForKuzmich({ tours: '901, 902', people: 'много' });
    expect(t).toContain('Число людей «много» не распознано (нужно 1–30)');
    expect(groupTotalMock).not.toHaveBeenCalled();
  });

  it('неизвестный критерий назван в ответе', async () => {
    const t = await compareToursForKuzmich({ tours: '901, 902', criteria: 'цена, безопасность' });
    expect(t).toMatch(/Не сравниваю: «безопасность» — правила безопасности тура — get_tour_details/);
  });

  it('отказ базы при чтении фактов — исключение, а не «туров нет»', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(compareToursForKuzmich({ tours: '901, 902' })).rejects.toThrow('boom');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('объявление инструмента', () => {
  it('в реестре MCP, только чтение, без внешнего мира', () => {
    const t = PUBLIC_MCP_TOOLS.find((x) => x.name === 'compare_tours');
    expect(t?.annotations).toEqual({ title: 'Compare tours', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect((t?.inputSchema as { required?: string[] }).required).toEqual(['tours']);
  });

  it('журнал хранит сравнение целиком, а не обрезок в 2000 знаков', () => {
    expect(journalToolOutput('compare_tours', 'y'.repeat(9000))).toHaveLength(9000);
  });
});
