// @vitest-environment node
/**
 * Супер-планер 22.11: «Сравнить и заменить» день и «План Б» для дней, которые
 * решает погода. Случай владельца: 24.11–04.12, двое взрослых, Авачинская зона
 * (дни и прогноз — снимок плана с прода, prod-after2/trip-days.json).
 */
import { describe, it, expect } from 'vitest';
import {
  compareRefusal, currentFacts, dayWithOption, optionFacts, parseDayOptions,
  type CompareDay, type DayOption,
} from '@/lib/planner/day-options';
import {
  codeRank, compareForecast, forecastFacts, swapDays, swapPlan, weatherDayKind, weatherKindOfActivity,
  type ForecastLike,
} from '@/lib/planner/weather-plan-b';
import { applyTourDayRead, awaitsTourReread } from '@/lib/planner/tour-day-apply';
import { TOUR_PRICE_PENDING_TEXT } from '@/lib/planner/calendar-days';
import { GROUP_MINIMUM_PREFIX } from '@/lib/planner/group-minimum';

type Day = CompareDay & { zone: 'avachinsky'; weatherForecast?: ForecastLike; weatherKit?: string };

const fc = (code: number, tempMin: number, tempMax: number, windKmh: number, precipMm: number, description: string): ForecastLike =>
  ({ code, tempMin, tempMax, windKmh, precipMm, description });

function day(n: number, type: string, title: string, activityType: string, wf: ForecastLike, tour?: { id: string; price?: number; unit: string; max: number; min: number; op: string }): Day {
  return {
    day: n, type, zone: 'avachinsky', title, description: '', activityType, coords: [53.0, 158.6],
    priceFrom: tour?.price ?? 0, priceTo: tour?.price ?? 0, dayWarnings: [],
    ...(tour?.price ? { realPrice: tour.price, availability: 'open' as const } : {}),
    ...(tour ? { realTour: { tourId: tour.id, priceUnit: tour.unit, maxParticipants: tour.max, minParticipants: tour.min, operatorName: tour.op, lodgingIncluded: null, calendar: 'dated' as const } } : {}),
    weatherForecast: wf,
  };
}

const THERMAL = { id: '112', unit: 'per_person', max: 8, min: 1, op: 'Лагуна Экспедиция' };
const OWNER: Day[] = [
  day(1, 'arrival', 'Прилёт днём. Размещение, акклиматизация. Прогулка по городу', 'hot_spring', fc(3, -18.3, -8.9, 10.2, 0, 'Пасмурно')),
  day(2, 'activity', 'Зимняя рыбалка: ноябрь — январь', 'fishing', fc(75, -14.1, -1.6, 9, 16.2, 'Сильный снег'), { id: '36', price: 22000, unit: 'per_day_per_person', max: 14, min: 5, op: 'Камчатская рыбалка' }),
  day(3, 'activity', 'Облёт вулканов Мутновский и Горелый + Ходуткинские горячие источники', 'helicopter', fc(85, -14.3, -10.8, 13, 5.8, 'Снегопад'), { id: '98', price: 55000, unit: 'per_person', max: 22, min: 1, op: 'Лагуна Экспедиция' }),
  day(4, 'activity', 'Камчатка: термальный маршрут', 'thermal', fc(85, -16.4, -13.9, 13.4, 0.8, 'Снегопад'), { ...THERMAL, price: 85000 }),
  day(5, 'activity', 'Камчатка: термальный маршрут — день 2 из 5', 'thermal', fc(3, -14.9, -10.8, 13.8, 0, 'Пасмурно'), THERMAL),
  day(6, 'activity', 'Камчатка: термальный маршрут — день 3 из 5', 'thermal', fc(75, -11.6, -5.6, 12.9, 58.3, 'Сильный снег'), THERMAL),
  day(7, 'activity', 'Камчатка: термальный маршрут — день 4 из 5', 'thermal', fc(85, -12.5, -9.8, 23.8, 102.1, 'Снегопад'), THERMAL),
  day(8, 'activity', 'Камчатка: термальный маршрут — день 5 из 5', 'thermal', fc(71, -14.7, -12.5, 15.4, 0.1, 'Снег'), THERMAL),
  day(9, 'activity', 'За снегоходом на Мыс Маячный', 'snowmobile', fc(73, -14.1, -8, 11.4, 2.7, 'Умеренный снег'), { id: '90', price: 15000, unit: 'per_person', max: 10, min: 1, op: 'Лагуна Экспедиция' }),
  day(10, 'buffer', 'Резервный день (нелётная погода)', 'hot_spring', fc(73, -15.1, -9.1, 4.6, 5.7, 'Умеренный снег')),
  day(11, 'departure', 'Сборы утром. Трансфер в аэропорт, вылет днём', 'departure', fc(2, -17, -13.4, 6.5, 0, 'Переменная облачность')),
];
const PEOPLE = 2;

function option(over: Partial<DayOption> = {}): DayOption {
  return {
    id: '501', title: 'Облёт Долины гейзеров', shortDescription: 'Вертолёт, 8 часов', activityType: 'helicopter',
    operatorName: 'Вертолёты Камчатки', operatorSlug: 'heli-kam', basePrice: 48000, priceUnit: 'per_person',
    minParticipants: 4, maxParticipants: 20, calendar: 'dated', otherZone: false, coords: [54.4, 160.1],
    read: { availability: 'open', checkedAt: '2026-11-22T03:00:00.000Z', availableDate: '2026-11-26', slotsRemaining: 6, realPrice: 48000, priceFrom: 48000, priceTo: 48000 },
    ...over,
  };
}

describe('«Сравнить и заменить»: честные «за» и «против» на случае владельца', () => {
  const heli = OWNER[2];

  it('день облёта сравнивается, день многодневного тура — нет, день без тура — нет', () => {
    expect(compareRefusal(OWNER, heli)).toBeNull();
    expect(compareRefusal(OWNER, OWNER[3])).toMatch(/несколько дней/);
    expect(compareRefusal(OWNER, OWNER[9])).toMatch(/нет тура/);
  });

  it('вариант: цена на группу против текущей, места на дату, набор группы, погода, оператор', () => {
    const facts = optionFacts(option(), heli, PEOPLE);
    const text = facts.map((f) => `${f.tone}:${f.text}`);
    expect(text).toContain('pro:96 000 ₽ на группу — дешевле на 14 000 ₽');
    expect(text).toContain('pro:На эту дату есть места (свободно 6)');
    expect(text).toContain('con:Нужен набор от 4 чел., вас 2 — выезд подтверждает оператор');
    expect(text.some((t) => t.startsWith('con:Зависит от погоды: вертолёт'))).toBe(true);
    expect(text).toContain('info:Оператор: Вертолёты Камчатки');
  });

  it('текущий тур — тем же словарём: 110 000 ₽ на двоих, вертолёт зависит от погоды', () => {
    const text = currentFacts(heli, PEOPLE).map((f) => f.text);
    expect(text[0]).toBe('110 000 ₽ на группу');
    expect(text.some((t) => t.startsWith('Зависит от погоды'))).toBe(true);
  });

  it('третье состояние: мест не прочитали, тур без календаря, цены нет — не «хорошо» и не «мест нет»', () => {
    const unread = optionFacts(option({ read: null }), heli, PEOPLE).map((f) => f.text);
    expect(unread[0]).toMatch(/не посчитали/);
    expect(unread).toContain('Места на дату не прочитали — уточните у оператора');
    const request = optionFacts(option({ calendar: 'request' }), heli, PEOPLE).map((f) => f.text);
    expect(request).toContain('Календаря выездов нет — дату подтвердит оператор по заявке');
    const noMin = optionFacts(option({ minParticipants: null }), heli, PEOPLE).map((f) => f.text);
    expect(noMin).toContain('Минимум группы оператор не указал');
  });

  it('«Поставить»: тур в дне, цена — «ещё не перечитали», строка набора группы; ответ перечитки ставит цену', () => {
    const put = dayWithOption(heli, option(), PEOPLE);
    expect(put.title).toBe('Облёт Долины гейзеров');
    expect(put.realTour?.tourId).toBe('501');
    expect(put.realPrice).toBeUndefined();
    expect(put.priceMissing).toBe(TOUR_PRICE_PENDING_TEXT);
    expect(put.availability).toBeUndefined();
    expect(put.dayWarnings[0].startsWith(GROUP_MINIMUM_PREFIX)).toBe(true);
    expect(awaitsTourReread(put)).toBe(true);
    const read = applyTourDayRead(put, '501', { availability: 'open', checkedAt: '2026-11-22T03:00:00.000Z', availableDate: '2026-11-26', realPrice: 48000, priceFrom: 48000, priceTo: 48000 });
    expect(read.realPrice).toBe(48000);
    expect(read.priceMissing).toBeUndefined();
    // Прежний тур не задет.
    expect(heli.realTour?.tourId).toBe('98');
  });

  it('ответ сервера проверяется по форме; кривой — неответ', () => {
    const ok = parseDayOptions({ success: true, options: [option()], orderNote: 'Место в списке не продаётся.' });
    expect(ok?.options[0].read?.realPrice).toBe(48000);
    expect(ok?.orderNote).toMatch(/не продаётся/);
    expect(parseDayOptions({ success: false })).toBeNull();
    expect(parseDayOptions({ success: true, options: [{ id: 1 }] })).toBeNull();
  });
});

describe('«План Б»: день, который решает погода', () => {
  it('облёт — вертолёт; рыбалка, термальный тур, снегоход — нет; море и восхождение узнаются', () => {
    expect(weatherDayKind(OWNER[2])).toBe('air');
    expect(weatherDayKind(OWNER[1])).toBeNull();
    expect(weatherDayKind(OWNER[3])).toBeNull();
    expect(weatherDayKind(OWNER[8])).toBeNull();
    expect(weatherKindOfActivity('boat_trip', 'Морская прогулка по Авачинской бухте')).toBe('sea');
    expect(weatherKindOfActivity('trekking', 'Восхождение на Авачинский вулкан')).toBe('volcano');
    expect(weatherKindOfActivity('volcano', '')).toBe('volcano');
    expect(weatherDayKind({ ...OWNER[2], type: 'buffer' })).toBeNull();
  });

  it('прогноз — фактами, без вердикта', () => {
    expect(forecastFacts(OWNER[2].weatherForecast!)).toBe('снегопад, осадки 5,8 мм, ветер до 4 м/с');
    expect(codeRank(45)).toBe(3);
    expect(codeRank(2)).toBe(0);
  });

  it('сравнение прогнозов: лучше — только если не хуже ни в чём', () => {
    const clear = fc(1, -10, -5, 7, 0, 'Ясно');
    const fog = fc(45, -10, -5, 7, 0, 'Туман');
    expect(compareForecast(fog, clear)).toBe('better');
    expect(compareForecast(clear, fog)).toBe('worse');
    expect(compareForecast(OWNER[2].weatherForecast!, OWNER[9].weatherForecast!)).toBe('mixed');
    expect(compareForecast(clear, { ...clear })).toBe('same');
  });

  it('обмен для облёта: резервный день первым, честно «в чём-то лучше», и что резерва после выезда не останется', () => {
    const plan = swapPlan(OWNER, 3);
    expect(plan.refusal).toBeNull();
    expect(plan.options.map((o) => o.day)).toEqual([10, 9]);
    expect(plan.options[0].comparison).toBe('mixed');
    expect(plan.options[0].note).toMatch(/резервного дня позже/);
    expect(plan.options[1].note).toBeNull();
    // Каркас и многодневный тур в обмен не идут.
    expect(plan.options.some((o) => [1, 4, 5, 11].includes(o.day))).toBe(false);
  });

  it('за горизонтом прогноза обмена нет — так и сказано', () => {
    const noFc = OWNER.map((d) => (d.day === 3 ? { ...d, weatherForecast: undefined } : d));
    const plan = swapPlan(noFc, 3);
    expect(plan.options).toEqual([]);
    expect(plan.refusal).toMatch(/Прогноза на эту дату ещё нет/);
  });

  it('«Поменять местами» 3 и 10: облёт встаёт на 10-й с прогнозом 10-го, резерв — на 3-й; цена облёта перечитывается', () => {
    const { days, newNumbers } = swapDays(OWNER, 3, 10);
    const heli = days.find((d) => d.realTour?.tourId === '98')!;
    expect(heli.day).toBe(10);
    expect(heli.weatherForecast).toEqual(OWNER[9].weatherForecast);
    expect(heli.weatherKit).toMatch(/^Прогноз для зоны дня: Умеренный снег/);
    expect(heli.priceMissing).toBe(TOUR_PRICE_PENDING_TEXT);
    const reserve = days.find((d) => d.type === 'buffer')!;
    expect(reserve.day).toBe(3);
    expect(reserve.weatherForecast).toEqual(OWNER[2].weatherForecast);
    expect(newNumbers.get(3)).toBe(10);
    expect(newNumbers.get(10)).toBe(3);
    expect(days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Остальные дни не тронуты.
    expect(days[3]).toBe(OWNER[3]);
  });
});
