/**
 * Правки плана «нас трое», «сдвинь поездку», «замени вулкан» и то, что от
 * даты и группы зависит (аудит планировщика 07.11, M3 и M4).
 *
 * До этой правки:
 *  - состава, сдвига и замены дня не было — только новый make_trip_plan, с
 *    новым ID и потерей прежних правок;
 *  - убрать или переставить день, задержка рейса с переносом билета ставили
 *    тур на другую дату, а места и цена оставались от прежней — ответ говорил
 *    «остальные дни не менялись»;
 *  - строки закрытия парков и сводок МЧС на днях жили с прежними датами.
 *
 * Сторож держит поведением, вызовом `applyPlanEdit` на плане с подменёнными
 * источниками: подбор дня, места и цена тура на дату, тревоги парков и МЧС,
 * «сегодня».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import type { DayPlan, TripRecommendation } from '@/lib/planner/engine';
import { applyPlanEdit, type EditablePlan, type EditDeps } from '@/lib/planner/plan-edit';
import type { TourDayInput, TourDayRead } from '@/lib/planner/tour-day-reread';
import type { SafetyRefreshDeps } from '@/lib/planner/plan-safety-refresh';
import type { PlanParkAlert } from '@/lib/planner/park-status';
import { MCHS_UNREAD_NOTE, offeringSentence, type ActiveWarning } from '@/lib/safety/mchs-bulletin';

const day = (n: number, type: DayPlan['type'], title: string, extra: Partial<DayPlan> = {}): DayPlan => ({
  day: n, type, zone: 'avachinsky', title, description: '',
  activityType: type === 'activity' ? 'volcano' : type === 'rest' ? 'hot_spring' : type,
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'jeep', allowedTransports: ['jeep'],
  difficulty: 'moderate', childFriendly: true, minChildAge: 0, dayWarnings: [],
  ...extra,
});

const tour = (tourId: string, title: string) => ({
  tourId, operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 0, tourRating: null, reviewCount: 0,
  verified: true, maxParticipants: 8, weatherDependent: false, durationHours: 8, priceUnit: 'per_person',
  lodgingIncluded: null, ...(title ? {} : {}),
});

/** План 7 дней с 10.07.2027: вулкан (тур), медведи (тур на два дня), отдых. */
function plan(): EditablePlan {
  return {
    params: { interests: ['volcano', 'bears'], arrivalDate: '2027-07-10', departureDate: '2027-07-16', adults: 2, children: [], budgetTier: 'comfort' },
    days: [
      day(1, 'arrival', 'Прилёт'),
      day(2, 'activity', 'Мутновский вулкан', {
        realTour: tour('t-volc', 'Мутновский'), availability: 'open', availableDate: '2027-07-11',
        slotsRemaining: 6, realPrice: 9000, priceFrom: 9000, priceTo: 10800,
        weatherForecast: { tempMax: 14, tempMin: 6, precipMm: 0, windKmh: 10, code: 1, description: 'ясно' },
      }),
      day(3, 'activity', 'Медведи на Курильском', { activityType: 'bears', realTour: tour('t-bear', 'Медведи'), availability: 'open', availableDate: '2027-07-12', slotsRemaining: 4, realPrice: 30000, priceFrom: 30000, priceTo: 36000 }),
      day(4, 'activity', 'Медведи на Курильском — день 2 из 2', { activityType: 'bears', realTour: tour('t-bear', 'Медведи') }),
      day(5, 'rest', 'Термальные источники'),
      day(6, 'activity', 'Авачинский вулкан'),
      day(7, 'departure', 'Отъезд'),
    ],
  };
}

const reads: TourDayInput[] = [];
const fakeRead = vi.fn(async (input: TourDayInput): Promise<TourDayRead> => {
  reads.push(input);
  return {
    availability: 'open', availableDate: input.date, slotsRemaining: 2,
    capacityWarning: `Свободно 2 из ${input.maxParticipants} мест, вас ${input.participants}. Возможно, придётся выбрать другую дату.`,
    realPrice: 11000 + input.participants, priceFrom: 11000 + input.participants, priceTo: 13200,
  };
});

let parkRows: PlanParkAlert[] = [];
let mchs: ActiveWarning[] = [];
let parkFails = false;
let mchsFails = false;
const safety: SafetyRefreshDeps = {
  loadWarnings: async () => (mchsFails ? { ok: false, warnings: [] } : { ok: true, warnings: mchs }),
  parkQuery: async <T,>() => {
    if (parkFails) throw Object.assign(new Error('down'), { code: '57P01' });
    return { rows: parkRows as unknown as T[] };
  },
};

let miniDay: DayPlan | null = null;
const recommend = vi.fn(async (): Promise<TripRecommendation> => ({
  days: miniDay ? [day(1, 'arrival', 'Прилёт'), miniDay, day(3, 'departure', 'Отъезд')] : [],
  warnings: [{ type: 'license', severity: 'important', message: 'Нужна путёвка на рыбалку.' }],
} as unknown as TripRecommendation));

const deps = (): EditDeps => ({ recommend, reread: fakeRead, safety, today: () => '2026-11-07' });

beforeEach(() => {
  reads.length = 0;
  fakeRead.mockClear();
  recommend.mockClear();
  parkRows = [];
  mchs = [];
  parkFails = false;
  mchsFails = false;
  miniDay = null;
});

describe('set_party — состав группы', () => {
  it('новый состав: дни те же, места и цена каждого тура перечитаны на новую группу, туры — «другой состав»', async () => {
    const before = plan();
    const r = await applyPlanEdit(before, { kind: 'set_party', adults: 3 }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.params.adults).toBe(3);
    expect(r.plan.days.map((d) => d.title)).toEqual(before.days.map((d) => d.title));
    // По разу на тур, с его первого дня, на группу из трёх.
    expect(reads.map((x) => `${x.tourId}:${x.date}:${x.participants}`)).toEqual(['t-volc:2027-07-11:3', 't-bear:2027-07-12:3']);
    const volc = r.plan.days[1];
    expect(volc.realPrice).toBe(11003);
    expect(volc.slotsRemaining).toBe(2);
    expect(volc.capacityWarning).toContain('вас 3');
    // Продолжение многодневного тура цены не несёт — как у движка.
    expect(r.plan.days[3].realPrice).toBeUndefined();
    expect(r.toursTouched?.map((t) => `${t.tourId}:${t.how}`)).toEqual(['t-volc:party', 't-bear:party']);
    expect(r.reread?.map((t) => t.tourId)).toEqual(['t-volc', 't-bear']);
    expect(r.note).toContain('3 взрослых, без детей (было: 2 взрослых, без детей)');
    // Даты не менялись — прогноз остаётся.
    expect(volc.weatherForecast).toBeTruthy();
    // Прежний план не тронут.
    expect(before.days[1].realPrice).toBe(9000);
  });

  it('ребёнок младше допуска занятия — отказ с днями, план прежний', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'set_party', children: [6] }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/Младшему 6/);
      expect(r.reason).toMatch(/вулкан[а-я]* \(дни 2, 6\) — с 12 лет/i);
      expect(r.reason).toContain('replace_day');
    }
    expect(fakeRead).not.toHaveBeenCalled();
  });

  it('названы только дети — взрослые прежние; тот же состав — отказ; группа больше 30 — отказ', async () => {
    const p = plan();
    p.days = p.days.filter((d) => d.activityType !== 'volcano').map((d, i) => ({ ...d, day: i + 1 }));
    const kids = await applyPlanEdit(p, { kind: 'set_party', children: [12, 8] }, deps());
    if (!kids.ok) throw new Error(kids.reason);
    expect(kids.plan.params.adults).toBe(2);
    expect(kids.plan.params.children).toEqual([12, 8]);
    expect(kids.note).toContain('2 взрослых и дети (12 лет, 8 лет)');

    const same = await applyPlanEdit(plan(), { kind: 'set_party', adults: 2, children: [] }, deps());
    expect(same).toMatchObject({ ok: false, reason: expect.stringMatching(/Состав уже такой/) });
    const big = await applyPlanEdit(plan(), { kind: 'set_party', adults: 25, children: [12, 12, 12, 12, 12, 12] }, deps());
    expect(big).toMatchObject({ ok: false, reason: expect.stringMatching(/не больше 30/) });
  });
});

describe('shift_dates — сдвиг всей поездки', () => {
  it('на неделю позже: дни те же, даты новые, места и цена туров — на новые даты, прогноз прежней даты снят', async () => {
    const before = plan();
    const r = await applyPlanEdit(before, { kind: 'shift_dates', days: 7 }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.params.arrivalDate).toBe('2027-07-17');
    expect(r.plan.params.departureDate).toBe('2027-07-23');
    expect(r.plan.days.map((d) => `${d.day}:${d.title}`)).toEqual(before.days.map((d) => `${d.day}:${d.title}`));
    expect(reads.map((x) => `${x.tourId}:${x.date}:${x.participants}`)).toEqual(['t-volc:2027-07-18:2', 't-bear:2027-07-19:2']);
    expect(r.plan.days[1].availableDate).toBe('2027-07-18');
    expect(r.plan.days[1].weatherForecast).toBeUndefined();
    expect(r.toursTouched?.every((t) => t.how === 'shifted')).toBe(true);
    expect(r.note).toMatch(/^Поездка сдвинута на 7 дней позже: 17 июля — 23 июля\./);
  });

  it('новая дата начала словами пришла датой: тот же сдвиг; диапазон другой длины — отказ', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'shift_dates', startDate: '2027-07-13' }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.params.arrivalDate).toBe('2027-07-13');
    expect(r.note).toContain('на 3 дня позже');
    const range = await applyPlanEdit(plan(), { kind: 'shift_dates', startDate: '2027-07-13', length: 9 }, deps());
    expect(range).toMatchObject({ ok: false, reason: expect.stringMatching(/на 9 дней, а поездка — 7 дней/) });
  });

  it('в прошлое по Камчатке — отказ; ноль — отказ; дальше года — отказ', async () => {
    const past = await applyPlanEdit(plan(), { kind: 'shift_dates', startDate: '2026-11-06' }, deps());
    expect(past).toMatchObject({ ok: false, reason: expect.stringMatching(/уже прошло/) });
    const today = await applyPlanEdit(plan(), { kind: 'shift_dates', startDate: '2026-11-07' }, deps());
    // Сегодня не прошло — но вулкан в ноябре не сезон: отказ уже по сезону.
    expect(today).toMatchObject({ ok: false, reason: expect.stringMatching(/не сезон/) });
    expect(await applyPlanEdit(plan(), { kind: 'shift_dates', days: 0 }, deps())).toMatchObject({ ok: false, reason: expect.stringMatching(/уже начинается/) });
    expect(await applyPlanEdit(plan(), { kind: 'shift_dates', days: 400 }, deps())).toMatchObject({ ok: false, reason: expect.stringMatching(/больше чем на год/) });
  });

  it('занятие вне сезона в новые даты — отказ с днём, датой и сезоном, план прежний', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'shift_dates', startDate: '2027-09-28' }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Вулкан и медведи — июль–сентябрь: дни 2–3 (29–30 сентября) в сезоне,
      // день 4 (1 октября) и день 6 (3 октября) — нет.
      expect(r.reason).toMatch(/день 4 — [^;]+, 1 октября, а сезон в июле–сентябре/);
      expect(r.reason).toMatch(/день 6 — [^;]+, 3 октября, а сезон в июле–сентябре/);
      expect(r.reason).not.toMatch(/день [23] —/);
      expect(r.reason).toContain('replace_day');
    }
    expect(fakeRead).not.toHaveBeenCalled();
  });
});

describe('сдвиг дат и строки безопасности дня', () => {
  const closure = (expiresIso: string): PlanParkAlert => ({
    ref_kind: 'tour', ref_id: 't-volc', alert_id: 'a-1', alert_type: 'park_closure',
    title: 'Природный парк «Вулканы Камчатки»: маршруты закрыты до 15 июля', description: null,
    published_iso: '2027-07-01T00:00:00Z', expires_iso: expiresIso,
  });

  it('сдвиг раньше — в окно закрытия парка: день получает строку закрытия, план — предупреждение', async () => {
    const p = plan();
    p.params.arrivalDate = '2027-07-20';
    p.params.departureDate = '2027-07-26';
    parkRows = [closure('2027-07-15T00:00:00Z')];
    const r = await applyPlanEdit(p, { kind: 'shift_dates', days: -10 }, deps());
    if (!r.ok) throw new Error(r.reason);
    const volc = r.plan.days[1];
    expect(volc.dayWarnings[0]).toMatch(/^Закрытие парка по сводке от 01\.07/);
    expect(r.warnings?.some((w) => /^День 2: Закрытие парка/.test(w))).toBe(true);
  });

  it('сдвиг позже — из окна закрытия: прежняя строка закрытия снята', async () => {
    const p = plan();
    p.days[1].dayWarnings = ['Закрытие парка по сводке от 01.07: «Природный парк закрыт». Перед выходом уточните у дирекции парка.', 'Возьмите треккинговые палки.'];
    parkRows = [closure('2027-07-15T00:00:00Z')];
    const r = await applyPlanEdit(p, { kind: 'shift_dates', days: 14 }, deps());
    if (!r.ok) throw new Error(r.reason);
    // 25.07 — после срока закрытия: строки закрытия на дне нет, своя строка дня — на месте.
    expect(r.plan.days[1].dayWarnings.some((t) => t.startsWith('Закрытие парка'))).toBe(false);
    expect(r.plan.days[1].dayWarnings).toContain('Возьмите треккинговые палки.');
  });

  it('статус парков не прочитался — прежние строки остаются, план говорит «проверить не удалось»', async () => {
    const p = plan();
    const old = 'Закрытие парка по сводке от 01.07: «Природный парк закрыт». Перед выходом уточните у дирекции парка.';
    p.days[1].dayWarnings = [old];
    parkFails = true;
    const r = await applyPlanEdit(p, { kind: 'shift_dates', days: 14 }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.days[1].dayWarnings).toEqual([old]);
    expect(r.warnings?.some((w) => /Статус природных парков на дни плана проверить не удалось/.test(w))).toBe(true);
  });

  it('сводка МЧС, срок которой кончается до нового начала, со дня снимается; новая — ставится', async () => {
    const ended: ActiveWarning = { kind: 'road', place: 'Мутновская дорога', stems: ['мутнов'], period: 'до 12.07', sourceUrl: null, relevantUntil: '2027-07-12' };
    const fresh: ActiveWarning = { kind: 'volcano', place: 'Авачинский', stems: ['авачин'], period: 'до 30.08', sourceUrl: null, relevantUntil: '2027-08-30' };
    const p = plan();
    p.days[1].dayWarnings = [offeringSentence(ended)];
    mchs = [ended, fresh];
    const r = await applyPlanEdit(p, { kind: 'shift_dates', days: 7 }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.days[1].dayWarnings).not.toContain(offeringSentence(ended));
    expect(r.plan.days[5].dayWarnings).toContain(offeringSentence(fresh));
    expect(r.warnings?.some((w) => w.startsWith('МЧС: не приближаться к вулканам Авачинский'))).toBe(true);
  });

  it('сводки МЧС не прочитались — прежние строки на месте, план говорит «не прочитаны»', async () => {
    const ended: ActiveWarning = { kind: 'road', place: 'Мутновская дорога', stems: ['мутнов'], period: null, sourceUrl: null, relevantUntil: '2027-07-12' };
    const p = plan();
    p.days[1].dayWarnings = [offeringSentence(ended)];
    mchsFails = true;
    const r = await applyPlanEdit(p, { kind: 'shift_dates', days: 7 }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.days[1].dayWarnings).toEqual([offeringSentence(ended)]);
    expect(r.warnings).toContain(MCHS_UNREAD_NOTE);
  });
});

describe('replace_day — замена дня', () => {
  it('день вулкана → рыбалка на ту же дату, той же группой; прежний тур выпал, остальные дни не тронуты', async () => {
    miniDay = day(2, 'activity', 'Рыбалка на Авче', { activityType: 'fishing', realTour: tour('t-fish', 'Рыбалка'), availability: 'open', availableDate: '2027-07-15', realPrice: 7000 });
    const before = plan();
    const r = await applyPlanEdit(before, { kind: 'replace_day', day: 6, interest: 'fishing' }, deps());
    if (!r.ok) throw new Error(r.reason);
    // Мини-поездка движка — на дату дня 6 (15.07), той же группой.
    expect(recommend).toHaveBeenCalledWith(expect.objectContaining({
      interests: ['fishing'], arrivalDate: '2027-07-14', departureDate: '2027-07-16', adults: 2, children: [],
    }));
    expect(r.plan.days[5]).toMatchObject({ day: 6, title: 'Рыбалка на Авче', activityType: 'fishing' });
    expect(r.plan.days.filter((d) => d.day !== 6)).toEqual(before.days.filter((d) => d.day !== 6));
    expect(r.plan.params.interests).toContain('fishing');
    expect(r.toursTouched).toEqual([]);
    expect(r.warnings).toContain('Нужна путёвка на рыбалку.');
    expect(r.note).toContain('Заменил день 6 (15 июля): было «Авачинский вулкан», стало «Рыбалка на Авче»');
    expect(fakeRead).not.toHaveBeenCalled();
  });

  it('занят резерв на нелётную погоду — ответ говорит, что резерва больше нет', async () => {
    miniDay = day(2, 'activity', 'Рыбалка на Авче', { activityType: 'fishing' });
    const p = plan();
    p.days[4] = day(5, 'buffer', 'Резерв на погоду');
    const r = await applyPlanEdit(p, { kind: 'replace_day', day: 5, interest: 'fishing' }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.note).toContain('Резерва на нелётную погоду в плане больше нет.');
    const plain = await applyPlanEdit(plan(), { kind: 'replace_day', day: 5, interest: 'fishing' }, deps());
    if (!plain.ok) throw new Error(plain.reason);
    expect(plain.note).not.toContain('Резерва');
  });

  it('прежний день был туром — он выпал, и это сказано', async () => {
    miniDay = day(2, 'activity', 'Рыбалка на Авче', { activityType: 'fishing' });
    const r = await applyPlanEdit(plan(), { kind: 'replace_day', day: 2, interest: 'fishing' }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.toursTouched).toEqual([{ tourId: 't-volc', title: 'Мутновский вулкан', how: 'dropped' }]);
  });

  it('прилёт, день многодневного тура, то же занятие, не по возрасту, другая зона, движок не нашёл — отказы', async () => {
    expect(await applyPlanEdit(plan(), { kind: 'replace_day', day: 1, interest: 'fishing' }, deps()))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/день прилёта/) });
    expect(await applyPlanEdit(plan(), { kind: 'replace_day', day: 4, interest: 'fishing' }, deps()))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/многодневного тура/) });
    expect(await applyPlanEdit(plan(), { kind: 'replace_day', day: 2, interest: 'volcano' }, deps()))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/уже «/) });
    const kids = plan();
    kids.params.children = [3];
    expect(await applyPlanEdit(kids, { kind: 'replace_day', day: 5, interest: 'fishing' }, deps()))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/с 5 лет, младшему 3/) });
    miniDay = day(2, 'activity', 'Рыбалка на Озерной', { activityType: 'fishing', zone: 'western' });
    expect(await applyPlanEdit(plan(), { kind: 'replace_day', day: 6, interest: 'fishing' }, deps()))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/только в зоне «Западная зона».*переездов/) });
    miniDay = null;
    expect(await applyPlanEdit(plan(), { kind: 'replace_day', day: 6, interest: 'fishing' }, deps()))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/не собрался/) });
  });
});

describe('прежние правки: тур, сменивший дату, перечитывается (M3)', () => {
  it('убрать день: туры после него встали раньше — места и цена на новые даты; убранный тур выпал', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'remove_day', day: 2 }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(reads.map((x) => `${x.tourId}:${x.date}`)).toEqual(['t-bear:2027-07-11']);
    expect(r.toursTouched?.map((t) => `${t.tourId}:${t.how}`)).toEqual(['t-volc:dropped', 't-bear:shifted']);
    expect(r.note).toContain('у их туров новые даты');
    expect(r.note).not.toContain('остальные дни не менялись');
  });

  it('переставить день: тур, сменивший место, перечитан на новую дату; день без тура — нет', async () => {
    const p = plan();
    p.days[4] = day(5, 'activity', 'Морская прогулка', { activityType: 'sea', realTour: tour('t-sea', 'Море'), availability: 'open', availableDate: '2027-07-14', slotsRemaining: 9 });
    const r = await applyPlanEdit(p, { kind: 'move_day', day: 6, to: 5 }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.days.map((d) => `${d.day}:${d.title}`).slice(4, 6)).toEqual(['5:Авачинский вулкан', '6:Морская прогулка']);
    expect(reads.map((x) => `${x.tourId}:${x.date}`)).toEqual(['t-sea:2027-07-15']);
    expect(r.plan.days[5].availableDate).toBe('2027-07-15');
    expect(r.toursTouched).toEqual([{ tourId: 't-sea', title: 'Морская прогулка', how: 'shifted' }]);
  });

  it('задержка рейса с прежним обратным билетом: оставшиеся дни на прежних датах — не перечитываются', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'flight_delay', days: 1, keepReturn: true }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(fakeRead).not.toHaveBeenCalled();
    expect(r.reread).toBeUndefined();
  });

  it('уровень жилья — ни дат, ни группы: ничего не перечитывается', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'set_lodging', tier: 'economy' }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(fakeRead).not.toHaveBeenCalled();
  });
});

describe('add_day — записка называет новую дату отъезда (#3199, Б21)', () => {
  it('день вставлен в середину: дни после него сдвинулись, отъезд — новой датой', async () => {
    miniDay = day(2, 'activity', 'Рыбалка на Авче', { activityType: 'fishing' });
    const r = await applyPlanEdit(plan(), { kind: 'add_day', interest: 'fishing' }, deps());
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.params.departureDate).toBe('2027-07-17');
    expect(r.note).toContain('Дни после него сдвинулись на день позже, отъезд теперь 17 июля');
    expect(r.note).not.toContain('остальные дни не менялись');
  });
});
