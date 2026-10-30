/**
 * Правило 1в (слово владельца 29.10, «1в 2б 3 да») — порядок предложений
 * туров на общих витринах. Судится вызовом функций на граничных данных.
 *
 * Что держит сторож:
 *   - жребий — FNV-1a с перемешиванием fmix32, воспроизводим: тот же день —
 *     тот же порядок, другой день — другой; вход не меняется; соседние id
 *     (туры одной компании, заведённые одной миграцией) не держатся вместе;
 *   - тур со свободной датой выше тура без даты, раньше дата — выше; ничья по
 *     дате — жребий, потом id;
 *   - компания с четырьмя турами тянет ОДИН билет жребия, а не четыре;
 *   - подписи: русская кончается «Место в списке не продаётся.», китайская
 *     говорит «не продаётся» (不出售);
 *   - фраза о датах различает пять исходов, включая «не загрузились» (§4.0).
 */
import { describe, it, expect } from 'vitest';
import {
  fnv1a32, fmix32, lotOf, tourLot, companyLot, compareTourOffers, orderOffers, orderOffersBy,
  groupOffersByCompany, roundRobinByCompany, offersSummary, offerDatesPhrase,
  offerOrderDay, pinnedOfferDay, OFFER_ORDER_NOTE, OFFER_ORDER_NOTE_GROUPED_RU, OFFER_ORDER_NOTE_AGENT,
  type DatesPhraseInput,
} from '@/lib/tours/offer-order';
import { ZH_TOURS_ORDER_NOTE, OPERATORS_ORDER_NOTE } from '@/lib/operators/order-note';

const DAY = '2026-10-29';

function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe('FNV-1a 32', () => {
  it('эталонные значения', () => {
    expect(fnv1a32('')).toBe(2166136261);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('по байтам UTF-8, а не по кодам UTF-16: кириллица и иероглифы', () => {
    // «ж» — два байта UTF-8 (0xD0 0xB6); по коду символа хэш был бы другим.
    let h = 2166136261;
    for (const b of [0xd0, 0xb6]) { h ^= b; h = Math.imul(h, 16777619); }
    expect(fnv1a32('ж')).toBe(h >>> 0);
  });

  it('fmix32 — эталон murmur3: ноль в ноль, единица — известное значение', () => {
    expect(fmix32(0)).toBe(0);
    expect(fmix32(1)).toBe(0x514e28b7);
    expect(lotOf('a')).toBe(fmix32(0xe40c292c));
  });

  it('жребий тура и компании различаются для одного id', () => {
    expect(tourLot(DAY, '7')).toBe(fmix32(fnv1a32(`${DAY}:7`)));
    expect(companyLot(DAY, '7')).toBe(fmix32(fnv1a32(`${DAY}:company:7`)));
    expect(tourLot(DAY, 7)).toBe(tourLot(DAY, '7'));
  });
});

describe('жребий перемешивает соседние id (ревью 29.10)', () => {
  // 75 туров с id подряд — как у туров одной компании, заведённых одной
  // миграцией. Голый FNV-1a ставил пары 2k/2k+1 соседями в ~42% дней.
  const ids = Array.from({ length: 75 }, (_, i) => 40 + i);
  const rows = ids.map((id) => ({ id, nearestFreeDate: null }));
  const days = Array.from({ length: 365 }, (_, d) => shiftDay(DAY, d));
  const orders = days.map((day) => orderOffers(rows, { day }).map((t) => t.id));

  it('пары последовательных id стоят соседями реже, чем в 10% дней', () => {
    let adjacent = 0;
    let pairs = 0;
    for (const order of orders) {
      const pos = new Map(order.map((id, i) => [id, i]));
      for (let k = 40; k < 114; k += 2) {
        pairs++;
        if (Math.abs(pos.get(k)! - pos.get(k + 1)!) === 1) adjacent++;
      }
    }
    expect(adjacent / pairs).toBeLessThan(0.1);
  });

  it('первая десятка: каждый тур попадает туда не реже 20 и не чаще 75 дней в году (ожидание ~49)', () => {
    const top = new Map<number, number>(ids.map((id) => [id, 0]));
    for (const order of orders) for (const id of order.slice(0, 10)) top.set(id, top.get(id)! + 1);
    const counts = [...top.values()];
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...counts)).toBeLessThanOrEqual(75);
  });
});

describe('orderOffers — порядок туров', () => {
  const undated = Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), nearestFreeDate: null }));

  it('воспроизводим: два вызова в один день — один порядок; вход не меняется', () => {
    const input = [...undated];
    const snapshot = input.map((t) => t.id);
    const a = orderOffers(input, { day: DAY }).map((t) => t.id);
    const b = orderOffers(input, { day: DAY }).map((t) => t.id);
    expect(a).toEqual(b);
    expect(input.map((t) => t.id)).toEqual(snapshot);
  });

  it('жребий не совпадает с номером тура: id — только последний ключ', () => {
    const a = orderOffers(undated, { day: DAY }).map((t) => t.id);
    expect(a).not.toEqual(undated.map((t) => t.id));
  });

  it('другой день — другой порядок хотя бы на одной паре', () => {
    const a = orderOffers(undated, { day: DAY }).map((t) => t.id);
    const b = orderOffers(undated, { day: shiftDay(DAY, 1) }).map((t) => t.id);
    expect(b).not.toEqual(a);
  });

  it('день по Камчатке: 29.10 в 13:00 UTC — уже 30.10 там', () => {
    expect(offerOrderDay(new Date('2026-10-29T13:00:00Z'))).toBe('2026-10-30');
    const viaNow = orderOffers(undated, { now: new Date('2026-10-29T13:00:00Z') }).map((t) => t.id);
    expect(viaNow).toEqual(orderOffers(undated, { day: '2026-10-30' }).map((t) => t.id));
  });

  it('закреплённый день листания: сегодня и вчера по Камчатке принимаются, прочее — сегодня', () => {
    const now = new Date('2026-10-29T13:00:00Z'); // на Камчатке уже 30.10
    expect(pinnedOfferDay('2026-10-30', now)).toBe('2026-10-30');
    expect(pinnedOfferDay('2026-10-29', now)).toBe('2026-10-29');
    expect(pinnedOfferDay('2026-10-28', now)).toBe('2026-10-30');
    expect(pinnedOfferDay('2026-10-31', now)).toBe('2026-10-30');
    expect(pinnedOfferDay('вчера', now)).toBe('2026-10-30');
    expect(pinnedOfferDay(undefined, now)).toBe('2026-10-30');
  });

  it('туры с датой выше туров без даты; раньше дата — выше', () => {
    const rows = [
      { id: '1', nearestFreeDate: null },
      { id: '2', nearestFreeDate: '2027-07-01' },
      { id: '3', nearestFreeDate: null },
      { id: '4', nearestFreeDate: '2026-11-05' },
    ];
    for (let d = 0; d < 10; d++) {
      const ids = orderOffers(rows, { day: shiftDay(DAY, d) }).map((t) => t.id);
      expect(ids.slice(0, 2)).toEqual(['4', '2']);
      expect(ids.slice(2).sort()).toEqual(['1', '3']);
    }
  });

  it('ничья по дате — жребий дня, не номер и не цена', () => {
    const rows = [{ id: '10', nearestFreeDate: '2026-11-05' }, { id: '20', nearestFreeDate: '2026-11-05' }];
    const byLot = [...rows].sort((a, b) => tourLot(DAY, a.id) - tourLot(DAY, b.id)).map((t) => t.id);
    expect(orderOffers(rows, { day: DAY }).map((t) => t.id)).toEqual(byLot);
    // На разных днях побеждают оба — значит решает жребий, а не id.
    const winners = new Set(Array.from({ length: 30 }, (_, d) => orderOffers(rows, { day: shiftDay(DAY, d) })[0].id));
    expect(winners).toEqual(new Set(['10', '20']));
  });

  it('равный жребий — по id числом (устойчивость), а не строкой', () => {
    const cmp = compareTourOffers(DAY);
    expect(cmp({ id: '9', nearestFreeDate: null }, { id: '9', nearestFreeDate: null })).toBe(0);
    // Строка, не похожая на дату, — «даты нет», а не ключ порядка.
    expect(cmp({ id: '1', nearestFreeDate: 'скоро' }, { id: '2', nearestFreeDate: '2026-11-01' })).toBeGreaterThan(0);
  });

  it('orderOffersBy — тот же порядок для строк с другим именем ключа', () => {
    const rows = undated.map((t, i) => ({ id: t.id, next_open_date: i % 3 === 0 ? `2026-12-${String(10 + i).padStart(2, '0')}` : null }));
    const via = orderOffersBy(rows, (r) => ({ id: r.id, nearestFreeDate: r.next_open_date }), { day: DAY }).map((r) => r.id);
    const direct = orderOffers(rows.map((r) => ({ id: r.id, nearestFreeDate: r.next_open_date })), { day: DAY }).map((r) => r.id);
    expect(via).toEqual(direct);
  });
});

describe('groupOffersByCompany — порядок компаний', () => {
  type Row = { id: string; nearestFreeDate: string | null; partnerId: string; partnerName: string };
  const big: Row[] = ['1', '2', '3', '4'].map((id) => ({ id, nearestFreeDate: null, partnerId: 'p-big', partnerName: 'Большая' }));
  const small: Row[] = [{ id: '5', nearestFreeDate: null, partnerId: 'p-small', partnerName: 'Малая' }];

  it('компания с четырьмя турами тянет один билет: доля побед около половины за 50 дней', () => {
    let bigFirst = 0;
    for (let d = 0; d < 50; d++) {
      const groups = groupOffersByCompany([...big, ...small], { day: shiftDay(DAY, d) });
      expect(groups.map((g) => g.tours.length).sort()).toEqual([1, 4]);
      if (groups[0].partnerId === 'p-big') bigFirst++;
    }
    expect(bigFirst / 50).toBeGreaterThanOrEqual(0.3);
    expect(bigFirst / 50).toBeLessThanOrEqual(0.7);
  });

  it('компания с датой выше компании без дат, раньше дата — выше', () => {
    const dated: Row = { id: '9', nearestFreeDate: '2027-06-01', partnerId: 'p-dated', partnerName: 'С датой' };
    const sooner: Row = { id: '8', nearestFreeDate: '2026-12-01', partnerId: 'p-sooner', partnerName: 'Раньше' };
    for (let d = 0; d < 10; d++) {
      const groups = groupOffersByCompany([...big, ...small, dated, sooner], { day: shiftDay(DAY, d) });
      expect(groups.slice(0, 2).map((g) => g.partnerId)).toEqual(['p-sooner', 'p-dated']);
    }
  });

  it('равная ближайшая дата у двух компаний — жребий компании, не алфавит и не порядок входа', () => {
    const a: Row = { id: '11', nearestFreeDate: '2026-11-05', partnerId: 'p-a', partnerName: 'Аааа' };
    const b: Row = { id: '12', nearestFreeDate: '2026-11-05', partnerId: 'p-b', partnerName: 'Бббб' };
    const sooner: Row = { id: '13', nearestFreeDate: '2026-11-03', partnerId: 'p-c', partnerName: 'Яяяя' };
    const firsts = new Set<string>();
    for (let d = 0; d < 40; d++) {
      const day = shiftDay(DAY, d);
      // Вход в обоих порядках: порядок групп от него не зависит.
      for (const input of [[a, b, sooner], [b, a, sooner]]) {
        const groups = groupOffersByCompany(input, { day });
        expect(groups[0].partnerId).toBe('p-c');
        const tied = groups.slice(1).map((g) => g.partnerId);
        expect(tied).toEqual(['p-a', 'p-b'].sort((x, y) => companyLot(day, x) - companyLot(day, y)));
        firsts.add(tied[0]);
      }
    }
    expect(firsts).toEqual(new Set(['p-a', 'p-b']));
  });

  it('внутри группы — порядок тура; тур с датой первым у своей компании', () => {
    const rows: Row[] = [...big.slice(0, 3), { id: '4', nearestFreeDate: '2027-01-10', partnerId: 'p-big', partnerName: 'Большая' }];
    const [g] = groupOffersByCompany(rows, { day: DAY });
    expect(g.tours[0].id).toBe('4');
    expect(g.tours.map((t) => t.id)).toEqual(orderOffers(rows, { day: DAY }).map((t) => t.id));
    expect(g.partnerName).toBe('Большая');
  });

  it('круг по компаниям: первый тур каждой, затем второй', () => {
    const groups = [
      { partnerId: 'a', partnerName: 'A', tours: ['a1', 'a2', 'a3'] },
      { partnerId: 'b', partnerName: 'B', tours: ['b1'] },
      { partnerId: 'c', partnerName: 'C', tours: ['c1', 'c2'] },
    ];
    expect(roundRobinByCompany(groups)).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
    expect(roundRobinByCompany([])).toEqual([]);
  });
});

describe('подписи правила', () => {
  it('русская кончается «Место в списке не продаётся.»; китайская говорит 不出售', () => {
    expect(OFFER_ORDER_NOTE.ru.endsWith('Место в списке не продаётся.')).toBe(true);
    expect(OFFER_ORDER_NOTE_GROUPED_RU.endsWith('Место в списке не продаётся.')).toBe(true);
    expect(OFFER_ORDER_NOTE_AGENT.endsWith('Место в списке не продаётся.')).toBe(true);
    expect(OFFER_ORDER_NOTE.zh).toContain('不出售');
    expect(OFFER_ORDER_NOTE.zh).toContain('最近出发');
    expect(OFFER_ORDER_NOTE.en).toMatch(/not for sale/);
  });

  it('китайская витрина /zh говорит тем же правилом; список компаний — по-прежнему по алфавиту', () => {
    expect(ZH_TOURS_ORDER_NOTE).toBe(OFFER_ORDER_NOTE.zh);
    expect(ZH_TOURS_ORDER_NOTE).not.toContain('旅行社名称');
    expect(OPERATORS_ORDER_NOTE).toBe('Компании идут по алфавиту. Место в списке не продаётся.');
  });

  it('сводка «N предложений от M компаний» склоняется', () => {
    expect(offersSummary(1, 1)).toBe('1 предложение от 1 компании');
    expect(offersSummary(2, 2)).toBe('2 предложения от 2 компаний');
    expect(offersSummary(5, 3)).toBe('5 предложений от 3 компаний');
    expect(offersSummary(11, 11)).toBe('11 предложений от 11 компаний');
    expect(offersSummary(21, 21)).toBe('21 предложение от 21 компании');
    expect(offersSummary(22, 22)).toBe('22 предложения от 22 компаний');
  });
});

describe('offerDatesPhrase — пять исходов', () => {
  const base: DatesPhraseInput = {
    nearestFreeDate: null, keepsSchedule: false, season_start: null, season_end: null,
    duration_type: 'hours', multi_day_count: null, duration_hours: 8,
  };

  it('не загрузились — так и сказано, даже при записанной дате', () => {
    expect(offerDatesPhrase({ ...base, nearestFreeDate: '2027-07-26' }, DAY, 'failed')).toBe('даты не загрузились');
  });

  it('есть свободная дата — с годом', () => {
    expect(offerDatesPhrase({ ...base, keepsSchedule: true, nearestFreeDate: '2027-07-26' }, DAY, 'ok'))
      .toBe('ближайшая дата со свободными местами — 26 июля 2027');
  });

  it('без календаря, с сезоном — даты по заявке в сезон', () => {
    expect(offerDatesPhrase({ ...base, season_start: '2027-07-15', season_end: '2027-10-15' }, DAY, 'ok'))
      .toBe('даты по заявке, сезон 15 июля 2027 — 15 октября 2027');
  });

  it('без календаря и без сезона — оператор подтвердит дату', () => {
    expect(offerDatesPhrase(base, DAY, 'ok')).toBe('даты не записаны — оператор подтвердит дату по заявке');
    // Прошедший сезон — тоже «окна нет», а не «сезон кончился» выдумкой.
    expect(offerDatesPhrase({ ...base, season_start: '2026-06-01', season_end: '2026-09-01' }, DAY, 'ok'))
      .toBe('даты не записаны — оператор подтвердит дату по заявке');
  });

  it('календарь есть, но всё занято — не «даты не записаны»', () => {
    expect(offerDatesPhrase({ ...base, keepsSchedule: true }, DAY, 'ok')).toBe('на открытые даты мест нет');
  });
});
