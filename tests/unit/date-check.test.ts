/**
 * Проверка дат после отказа «погода или безопасность» (план «после отказа»,
 * этап 2в; слово владельца 11.11, вопрос 3: «проверка обстановки и места, а
 * не догадка», «с объяснением причины замены»).
 *
 * Держит вызовом:
 *  - место: закрыто, красный, жёлтый — опасное; статуса нет, он устарел или
 *    не прочитался — «не проверено»; главного места нет, оно вне сводок края
 *    или без зоны — данных для проверки нет вовсе;
 *  - дата отказа вне прогноза или уже прошла — проверять нечем, и это
 *    решается раньше места и зоны: статусы «на сейчас» о ней не говорят;
 *  - оценка опасности зоны — тоже «на сейчас»: высокая — отдельный исход, а
 *    не «опасное на вашу дату»;
 *  - предупреждение относится к туру, только когда предикат мест отнёс его к
 *    ГЛАВНОМУ МЕСТУ тура (lib/trips/tour-place-alerts). Совпадение зон тура и
 *    предупреждения ничего не значит: запрет у вулкана той же зоны морской
 *    прогулке не причина (ревью 2в, третий проход);
 *  - предупреждение уровня 1 по месту — препятствие для свободной даты
 *    всегда: «официальные предупреждения проверены» нельзя говорить, читая
 *    только уровень 2. Причиной на дате отказа оно служит, только когда это
 *    условия дня (погода, вода, лавины, оползни, пепел): постоянный режим —
 *    пропуска на дороге, класс пожарной опасности, замеченный медведь —
 *    действовал и в день заявки, и причиной отказа по погоде не называется.
 *    Но и не замалчивается: отдаётся списком `standing`, человеку его называют
 *    с оговоркой «причина ли это отказа, Ведар не знает»;
 *  - в данных Ведара причина отказа не отражена — дат не называем: оператор
 *    знает больше;
 *  - «не проверено» нигде не сходит за «чисто» (§4.0): прогноз из запаса,
 *    день без прогноза, отказ ленты, зона без действующей оценки,
 *    предупреждение, место которого не установлено, сбой на одной дате;
 *  - известная опасность главнее неизвестности: ветер на дату отказа назван и
 *    тогда, когда зона или статус места не прочитались, — но ни одна
 *    свободная дата при этом проверенной не считается;
 *  - «без установленного места» — не всё, у чего пусты зоны: закрытие парка,
 *    дорога или пожар с координатой, вулкан — место установлено; род с точным
 *    местом без привязки — не установлено и при записанной зоне;
 *  - причина «не проверено» пишется в лог своими словами; тур без координат
 *    или главного места — отдельной строкой: ему даты не будут названы никогда.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertPlaceKnown, checkTourDates, explainsWeatherDecline, judgePlace, unplacedAlertsOn, type DateCheckDeps } from '@/lib/trips/date-check';
import type { SituationSources, TourSite } from '@/lib/trips/situation-store';
import { mergeRepublished, type PlaceAlert, type TourPlaceAlerts } from '@/lib/trips/tour-place-alerts';
import type { TourPlaceStatus } from '@/lib/safety/tour-place-status';
import type { ForecastDay, ForecastResult } from '@/lib/planner/intelligence';
import type { OfficialAlert } from '@/lib/agents/evo/rescue-judge';
import { PLACE_SCOPED_TYPES } from '@/lib/services/safety/alert-place-scope';

const place = (over: Partial<TourPlaceStatus> = {}): TourPlaceStatus => ({
  place_id: 'p1', place: 'Авачинский', level: 'green', color: 'green', closed: false, stale: false,
  outside_sources: false, status_updated_at: '2027-01-12T00:00:00Z', ...over,
});
const GREEN = place();
const YELLOW = place({ level: 'yellow', color: 'yellow' });
const RED = place({ level: 'red', color: 'red' });
const CLOSED = place({ level: 'closed', color: 'green', closed: true });
const STALE = place({ level: 'unknown', color: null, stale: true });
const NO_STATUS = place({ level: 'unknown', color: null, status_updated_at: null });
const OUTSIDE = place({ level: 'unknown', color: null, outside_sources: true });

describe('judgePlace', () => {
  it('зелёный свежий — годится; закрыто, красный, жёлтый — опасное', () => {
    expect(judgePlace(GREEN)).toEqual({ kind: 'ok' });
    expect(judgePlace(YELLOW)).toEqual({ kind: 'risk', level: 'yellow' });
    expect(judgePlace(RED)).toEqual({ kind: 'risk', level: 'red' });
    // Закрытие ставит человек: оно опасное и при зелёном цвете.
    expect(judgePlace(CLOSED)).toEqual({ kind: 'risk', level: 'closed' });
  });
  it('места нет или оно вне сводок края — «нет данных»; не прочитался, устарел, не рассчитан — «не проверено», каждое своими словами', () => {
    expect(judgePlace(null)).toEqual({ kind: 'missing' });
    expect(judgePlace(OUTSIDE)).toEqual({ kind: 'outside' });
    expect(judgePlace('failed')).toEqual({ kind: 'unchecked', why: 'статус главного места не прочитался' });
    expect(judgePlace(STALE)).toEqual({ kind: 'unchecked', why: 'статус главного места устарел' });
    expect(judgePlace(NO_STATUS)).toEqual({ kind: 'unchecked', why: 'статус главного места не рассчитан' });
  });
  it('вне сводок края, но красное или закрытое — опасное: такой цвет там настоящий', () => {
    expect(judgePlace(place({ level: 'red', color: 'red', outside_sources: true }))).toEqual({ kind: 'risk', level: 'red' });
    expect(judgePlace(place({ level: 'closed', color: null, closed: true, outside_sources: true }))).toEqual({ kind: 'risk', level: 'closed' });
  });
});

// Сегодня по Камчатке — 12.01.2027; прогноз — по 16.01 включительно.
const NOW = Date.parse('2027-01-12T03:00:00Z');
const D12 = '2027-01-12';
const D13 = '2027-01-13';
const D14 = '2027-01-14';
const D15 = '2027-01-15';
const D16 = '2027-01-16';
const D17 = '2027-01-17';
const SITE: TourSite = {
  tourId: 42, title: 'Авачинский', operatorId: 'op', activityType: 'hiking', locationType: 'volcano',
  zone: 'avachinsky', lat: 53.25, lng: 158.83,
};
const day = (date: string, windKmh: number | null, weatherCode: number | null = 3): ForecastDay =>
  ({ date, tempMax: null, tempMin: null, precipMm: null, windKmh, weatherCode, description: 'облачно' });
/** 13.01 — ветер 90 км/ч; остальные дни спокойные. */
const DAYS = [day(D12, 10), day(D13, 90), day(D14, 12), day(D15, 8), day(D16, 11)];
const CALM = DAYS.map((x) => day(x.date, 10));
const calm = async (): Promise<ForecastResult> => ({ ok: true, days: CALM });
/** Строка общей ленты (OFFICIAL_ALERTS_SQL). */
const alert = (over: Partial<OfficialAlert> = {}): OfficialAlert => ({
  id: 1, alert_type: 'weather', severity: 2, title: 'Штормовое предупреждение', description: null,
  affected_zones: ['avachinsky'], expires_at: '2027-01-14T00:00:00+12:00', source_url: null, ...over,
} as OfficialAlert);
/** Предупреждение, которое предикат мест отнёс к главному месту тура. Действует по 13.01 включительно. */
const placeAlert = (over: Partial<PlaceAlert> = {}): PlaceAlert => ({
  id: '7', alert_type: 'weather', severity: 1, title: 'Жёлтый уровень: сильный ветер',
  expires_at: '2027-01-13T12:00:00.000Z', ...over,
});
const alertsOf = (alerts: PlaceAlert[] = [], zone: string | null = 'avachinsky') => async (): Promise<TourPlaceAlerts> => ({ zone, alerts });

function sources(over: Partial<SituationSources> = {}): SituationSources {
  return {
    forecast: async (): Promise<ForecastResult> => ({ ok: true, days: DAYS }),
    officials: async () => [],
    zone: async () => ({ name: 'Авачинско-Петропавловский', level: 'low' }),
    ...over,
  };
}
const deps = (over: Partial<DateCheckDeps> = {}): DateCheckDeps => ({
  sources: sources(), site: async () => SITE, place: async () => GREEN, placeAlerts: alertsOf(), now: () => NOW, ...over,
});

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe('предупреждение, место которого не установлено', () => {
  const day0 = '2026-09-26';
  const storm = (over: Partial<OfficialAlert> = {}) => alert({ expires_at: '2026-09-28T00:00:00Z', ...over });

  it('род, судимый зоной: место установлено зоной; без зон — нет; землетрясение — и координатой эпицентра', () => {
    expect(alertPlaceKnown(storm())).toBe(true);
    expect(alertPlaceKnown(storm({ affected_zones: ['krai_south'] }))).toBe(true);
    expect(alertPlaceKnown(storm({ affected_zones: [] }))).toBe(false);
    expect(alertPlaceKnown(storm({ affected_zones: null }))).toBe(false);
    // Погодное с координатой, но без зон: по координате такой род никто не судит — место не установлено.
    expect(alertPlaceKnown(storm({ alert_type: 'avalanche', affected_zones: [], lat: 53.1, lng: 158.6 }))).toBe(false);
    expect(alertPlaceKnown(storm({ alert_type: 'earthquake', affected_zones: [], lat: 49.5, lng: 156 }))).toBe(true);
    expect(alertPlaceKnown(storm({ alert_type: 'earthquake', affected_zones: [], lat: 49.5, lng: null }))).toBe(false);
  });

  it('род с точным местом: установлено только своей привязкой — парком, координатой, вулканом; зона её не заменяет', () => {
    // Закрытие парка пишется без зон по построению (#2133): его место — парк.
    expect(alertPlaceKnown(storm({ alert_type: 'park_closure', affected_zones: [], affected_parks: ['nalychevo'] }))).toBe(true);
    expect(alertPlaceKnown(storm({ alert_type: 'park_status_unknown', affected_zones: [], affected_parks: ['nalychevo'] }))).toBe(true);
    expect(alertPlaceKnown(storm({ alert_type: 'park_closure', affected_zones: [], affected_parks: [] }))).toBe(false);
    expect(alertPlaceKnown(storm({ alert_type: 'park_closure', affected_zones: [], affected_parks: null }))).toBe(false);
    // Дорога и пожар — координатой (pg отдаёт numeric строкой); половины координаты мало.
    expect(alertPlaceKnown(storm({ alert_type: 'road_closure', affected_zones: [], lat: '52.72', lng: '158.20' }))).toBe(true);
    expect(alertPlaceKnown(storm({ alert_type: 'fire_danger', affected_zones: [], lat: 54.1, lng: 159.9 }))).toBe(true);
    expect(alertPlaceKnown(storm({ alert_type: 'road_closure', affected_zones: [], lat: '52.72', lng: null }))).toBe(false);
    expect(alertPlaceKnown(storm({ alert_type: 'road_closure', affected_zones: [], lat: null, lng: '158.20' }))).toBe(false);
    // Запрет у вулкана — вулканом.
    expect(alertPlaceKnown(storm({ alert_type: 'volcanic_eruption', affected_zones: [], volcano_ark_id: '6f1c0e1e-0000-4000-8000-000000000001' }))).toBe(true);
    expect(alertPlaceKnown(storm({ alert_type: 'volcanic_eruption', volcano_ark_id: null }))).toBe(false);
  });

  it('каждый род с точным местом без привязки — «не установлено», даже с зоной: новый род без ветки здесь краснеет', () => {
    for (const type of PLACE_SCOPED_TYPES) {
      expect(alertPlaceKnown(storm({ alert_type: type, affected_zones: ['avachinsky'] })), type).toBe(false);
    }
  });

  it('в счёт идут только серьёзные (уровень 2+) и действующие в этот день', () => {
    const lost = storm({ id: 5, affected_zones: [] });
    expect(unplacedAlertsOn([lost], day0).map((a) => a.id)).toEqual([5]);
    // Истекло до начала дня по Камчатке; слабое; с установленным местом.
    expect(unplacedAlertsOn([lost], '2026-10-01')).toEqual([]);
    expect(unplacedAlertsOn([storm({ severity: 1, affected_zones: [] })], day0)).toEqual([]);
    expect(unplacedAlertsOn([storm()], day0)).toEqual([]);
    expect(unplacedAlertsOn([storm({ alert_type: 'park_closure', affected_zones: [], affected_parks: ['nalychevo'] })], day0)).toEqual([]);
    // Неприбитая дорога с зоной — не установлено.
    expect(unplacedAlertsOn([storm({ alert_type: 'road_closure' })], day0)).toHaveLength(1);
  });
});

describe('предупреждение, переизданное в ленте', () => {
  it('тот же заголовок под разными номерами — одна строка с наибольшим уровнем и самым поздним сроком', () => {
    const merged = mergeRepublished([
      placeAlert({ id: '1', title: 'Жёлтый уровень:  сильный ветер', severity: 1, expires_at: '2027-01-13T12:00:00.000Z' }),
      placeAlert({ id: '2', title: 'жёлтый уровень: сильный ветер', severity: 2, expires_at: '2027-01-14T18:00:00.000Z' }),
      placeAlert({ id: '3', title: 'Проезд по пропускам', severity: 1, expires_at: '2027-01-20T00:00:00.000Z' }),
    ]);
    expect(merged).toEqual([
      expect.objectContaining({ id: '1', severity: 2, expires_at: '2027-01-14T18:00:00.000Z' }),
      expect.objectContaining({ id: '3', title: 'Проезд по пропускам', severity: 1 }),
    ]);
    // Вход не меняется: источник строк — чужой массив.
    expect(mergeRepublished([])).toEqual([]);
  });
});

describe('checkTourDates: видят ли данные Ведара причину отказа', () => {
  it('на дату отказа — ветер в прогнозе: причина названа, свободные даты судятся тем же', async () => {
    const r = await checkTourDates(42, D13, [D17, D16, D14, D12], deps());
    expect(r).toEqual({
      state: 'confirmed', risks: ['погода: ветер до 90 км/ч'],
      clear: [D12, D14, D16], risk: 0, unchecked: 0, beyond: 1, place: 'Авачинский', zoneAssessed: true,
    });
  });

  it('проверено всё, и на дату отказа ничего нет — дат не называем: оператор знает больше', async () => {
    expect(await checkTourDates(42, D14, [D15, D16], deps()))
      .toEqual({ state: 'unconfirmed', place: 'Авачинский', zoneAssessed: true });
  });

  it('предупреждение по главному месту, действующее на дату отказа, — причина; жёлтый уровень погоды (1) тоже; после его срока дата проходит', async () => {
    // Жёлтый уровень (severity 1) место не красит, но в данных Ведара он есть — и на дату отказа действует.
    const d = deps({ sources: sources({ forecast: calm }), placeAlerts: alertsOf([placeAlert()]) });
    expect(await checkTourDates(42, D13, [D12, D14, D15], d)).toEqual({
      state: 'confirmed', risks: ['официальное предупреждение: Жёлтый уровень: сильный ветер'],
      // 12.01 — под тем же предупреждением; 14.01 и 15.01 — после его срока.
      clear: [D14, D15], risk: 1, unchecked: 0, beyond: 0, place: 'Авачинский', zoneAssessed: true,
    });
    // Дата отказа уже после срока предупреждения — оно не причина.
    expect(await checkTourDates(42, D14, [D15], d)).toEqual({ state: 'unconfirmed', place: 'Авачинский', zoneAssessed: true });
  });

  it('постоянный режим уровня 1 причиной отказа по погоде не называется, но и не замалчивается; свободную дату он держит', async () => {
    // Пропуска на дороге, класс пожарной опасности (запись живёт 168 ч), замеченный медведь: всё это
    // действовало и в день заявки. Срок записи кончается 13.01 — без правила 14.01 была бы названа
    // «проверенной» под причиной «3 класс пожарной опасности», которую оператор не называл.
    for (const alert_type of ['fire_danger', 'road_closure', 'bear', 'earthquake', 'volcanic_eruption', 'park_status_unknown', 'info', null]) {
      const standing = placeAlert({ alert_type, title: ' Режим,  который был\nи вчера ' });
      const d = deps({ sources: sources({ forecast: calm }), placeAlerts: alertsOf([standing]) });
      // Дат нет, а само предупреждение отдано как есть — человеку его назовут с оговоркой «причина ли это, не знаю».
      expect(await checkTourDates(42, D13, [D14, D15], d), String(alert_type))
        .toEqual({ state: 'unconfirmed', place: 'Авачинский', zoneAssessed: true, standing: ['Режим, который был и вчера'] });
      // На дату после срока записи оно уже не действует — и не называется.
      expect(await checkTourDates(42, D14, [D15], d), String(alert_type))
        .toEqual({ state: 'unconfirmed', place: 'Авачинский', zoneAssessed: true });
    }
    // Несколько — все, по убыванию уровня (порядок источника): уровень 1 у обоих — как пришли.
    const two = deps({
      sources: sources({ forecast: calm }),
      placeAlerts: alertsOf([placeAlert({ alert_type: 'road_closure', title: 'Проезд по пропускам' }), placeAlert({ alert_type: 'bear', title: 'У посёлка замечен медведь' })]),
    });
    expect(await checkTourDates(42, D13, [D14], two)).toMatchObject({ state: 'unconfirmed', standing: ['Проезд по пропускам', 'У посёлка замечен медведь'] });
    // При ветре на дату отказа причина — ветер, и только он; день под тем же режимом проверку не проходит.
    const fire = placeAlert({ alert_type: 'fire_danger', title: 'В лесах 3 класс пожарной опасности' });
    expect(await checkTourDates(42, D13, [D12, D14], deps({ placeAlerts: alertsOf([fire]) }))).toEqual({
      state: 'confirmed', risks: ['погода: ветер до 90 км/ч'],
      clear: [D14], risk: 1, unchecked: 0, beyond: 0, place: 'Авачинский', zoneAssessed: true,
    });
    // Уровень 2 — «опасно», закрытие или запрет: причина при любом роде.
    const closed = placeAlert({ alert_type: 'road_closure', severity: 2, title: 'Дорога закрыта' });
    expect(await checkTourDates(42, D13, [D12], deps({ sources: sources({ forecast: calm }), placeAlerts: alertsOf([closed]) })))
      .toMatchObject({ state: 'confirmed', risks: ['официальное предупреждение: Дорога закрыта'], clear: [], risk: 1 });
  });

  it('что объясняет отказ по погоде: уровень 2 и выше — любой род; уровень 1 — только условия дня', () => {
    for (const alert_type of ['weather', 'flood', 'avalanche', 'landslide', 'ash_cloud']) {
      expect(explainsWeatherDecline({ alert_type, severity: 1 }), alert_type).toBe(true);
    }
    for (const alert_type of ['fire_danger', 'road_closure', 'bear', 'earthquake', 'volcanic_eruption', 'park_closure', 'park_status_unknown', 'tsunami_warning', 'info', null]) {
      expect(explainsWeatherDecline({ alert_type, severity: 1 }), String(alert_type)).toBe(false);
      expect(explainsWeatherDecline({ alert_type, severity: 2 }), String(alert_type)).toBe(true);
      expect(explainsWeatherDecline({ alert_type, severity: 3 }), String(alert_type)).toBe(true);
    }
  });

  it('срок предупреждения — по началу дня на Камчатке: истекло ровно в полночь — в этот день уже не действует', async () => {
    // 14.01 00:00 по Камчатке = 13.01 12:00 UTC.
    const untilMidnight = placeAlert({ expires_at: '2027-01-13T12:00:00.000Z' });
    const pastMidnight = placeAlert({ expires_at: '2027-01-13T12:00:01.000Z' });
    const check = (a: PlaceAlert) => checkTourDates(42, D14, [D15], deps({ sources: sources({ forecast: calm }), placeAlerts: alertsOf([a]) }));
    expect(await check(untilMidnight)).toMatchObject({ state: 'unconfirmed' });
    expect(await check(pastMidnight)).toMatchObject({ state: 'confirmed', risks: ['официальное предупреждение: Жёлтый уровень: сильный ветер'] });
  });

  it('предупреждение той же зоны, которое к главному месту не относится, — не причина и не препятствие', async () => {
    // Запрет подходить к вулкану: зона та же, что у тура, срок — двое суток. К месту морской прогулки
    // предикат мест его не отнёс (дальше кольца) — в общей ленте он есть, среди предупреждений места — нет.
    const ban = alert({
      id: 31, alert_type: 'volcanic_eruption', title: 'Вулкан Мутновский: не приближаться',
      affected_zones: ['avachinsky'], volcano_ark_id: '6f1c0e1e-0000-4000-8000-000000000001', expires_at: '2027-01-14T12:00:00Z',
    });
    // Штормовое по зоне, которое предикат к месту не отнёс (морская тревога на горном месте).
    const marine = alert({ id: 32, title: 'Штормовое предупреждение: волнение моря', expires_at: '2027-01-14T12:00:00Z' });
    const d = deps({ sources: sources({ forecast: calm, officials: async () => [ban, marine] }) });
    expect(await checkTourDates(42, D13, [D14, D15], d)).toEqual({ state: 'unconfirmed', place: 'Авачинский', zoneAssessed: true });
    // При ветре на дату отказа эти предупреждения свободным датам не мешают.
    const windy = deps({ sources: sources({ officials: async () => [ban, marine] }) });
    expect(await checkTourDates(42, D13, [D14, D15], windy)).toMatchObject({ state: 'confirmed', risks: ['погода: ветер до 90 км/ч'], clear: [D14, D15], risk: 0 });
  });

  it('дата отказа дальше прогноза — «вне прогноза», уже прошла — «прошла»; источники не спрашиваются', async () => {
    const forecast = vi.fn(async (): Promise<ForecastResult> => ({ ok: true, days: DAYS }));
    const officials = vi.fn(async () => []);
    const zone = vi.fn(async () => ({ name: 'Авачинско-Петропавловский', level: 'low' as const }));
    const d = deps({ sources: sources({ forecast, officials, zone }) });
    expect(await checkTourDates(42, D17, [D13, D14], d)).toEqual({ state: 'beyond' });
    expect(await checkTourDates(42, '2027-01-11', [D13], d)).toEqual({ state: 'past' });
    expect(forecast).not.toHaveBeenCalled();
    expect(officials).not.toHaveBeenCalled();
    expect(zone).not.toHaveBeenCalled();
    // Сегодня и последний день прогноза — в пределах.
    expect(await checkTourDates(42, D12, [D13], d)).toMatchObject({ state: 'unconfirmed' });
    expect(await checkTourDates(42, D16, [D13], d)).toMatchObject({ state: 'unconfirmed' });
  });

  it('дальняя или прошедшая дата решается раньше места: статус «на сейчас» о ней не говорит', async () => {
    // Место сейчас жёлтое, закрытое, с устаревшим статусом или не прочиталось — о дате через месяц это ничего не значит.
    for (const p of [YELLOW, CLOSED, STALE, NO_STATUS]) {
      expect(await checkTourDates(42, D17, [D14], deps({ place: async () => p }))).toEqual({ state: 'beyond' });
      expect(await checkTourDates(42, '2027-01-11', [D14], deps({ place: async () => p }))).toEqual({ state: 'past' });
    }
    expect(await checkTourDates(42, D17, [D14], deps({ place: async () => { throw new Error('обрыв'); } }))).toEqual({ state: 'beyond' });
    // А вот «данных нет вовсе» главнее: так будет при любой дате.
    expect(await checkTourDates(42, D17, [D14], deps({ place: async () => null }))).toEqual({ state: 'no_data', missing: ['place'] });
  });

  it('сама дата отказа и повторы среди кандидатов не считаются', async () => {
    const r = await checkTourDates(42, D13, [D13, D14, D14], deps());
    expect(r).toMatchObject({ state: 'confirmed', clear: [D14], risk: 0, unchecked: 0, beyond: 0 });
  });

  it('свободная дата до сегодняшнего дня — вне прогноза, а не «проверить не удалось»: прогноз о ней не спрашивается', async () => {
    const forecast = vi.fn(async (): Promise<ForecastResult> => ({ ok: true, days: DAYS }));
    const r = await checkTourDates(42, D13, ['2027-01-10', '2027-01-11', D14], deps({ sources: sources({ forecast }) }));
    expect(r).toMatchObject({ state: 'confirmed', clear: [D14], unchecked: 0, beyond: 2 });
    // Дата отказа и одна свободная в пределах прогноза — два вопроса к прогнозу, не четыре.
    expect(forecast).toHaveBeenCalledTimes(2);
  });
});

describe('checkTourDates: место', () => {
  it('главное место закрыто, красное или жёлтое — ни одной даты, источники не спрашиваются', async () => {
    const forecast = vi.fn(async (): Promise<ForecastResult> => ({ ok: true, days: DAYS }));
    const zone = vi.fn(async () => ({ name: 'Авачинско-Петропавловский', level: 'high' as const }));
    for (const [p, level] of [[CLOSED, 'closed'], [RED, 'red'], [YELLOW, 'yellow']] as const) {
      expect(await checkTourDates(42, D13, [D14], deps({ place: async () => p, sources: sources({ forecast, zone }) })))
        .toEqual({ state: 'place_risk', place: 'Авачинский', level });
    }
    expect(forecast).not.toHaveBeenCalled();
    // Место сейчас опасно — раньше зоны: зона не спрашивается.
    expect(zone).not.toHaveBeenCalled();
  });

  it('статус места устарел, не рассчитан или не прочитался, опасного на дату отказа нет — «не проверено», причина в логе', async () => {
    const quiet = sources({ forecast: calm });
    for (const [p, words] of [[STALE, 'устарел'], [NO_STATUS, 'не рассчитан']] as const) {
      expect(await checkTourDates(42, D13, [D14], deps({ place: async () => p, sources: quiet }))).toEqual({ state: 'unchecked', why: [expect.stringContaining(words)] });
    }
    expect(await checkTourDates(42, D13, [D14], deps({ sources: quiet, place: async () => { throw Object.assign(new Error('boom'), { code: '57014' }); } })))
      .toEqual({ state: 'unchecked', why: ['статус главного места не прочитался'] });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('статус главного места не прочитался'), 'SQLSTATE=57014');
    expect(warn).toHaveBeenCalledWith('[date-check] тур 42: даты после отказа по погоде не проверены — статус главного места устарел');
  });

  it('известная опасность главнее неизвестности: ветер на дату отказа назван и при непрочитанном месте — но ни одна свободная дата не проверена', async () => {
    const forecast = vi.fn(async (): Promise<ForecastResult> => ({ ok: true, days: DAYS }));
    const r = await checkTourDates(42, D13, [D12, D14, D15, D17], deps({ place: async () => STALE, sources: sources({ forecast }) }));
    expect(r).toEqual({
      state: 'confirmed', risks: ['погода: ветер до 90 км/ч'], clear: [], risk: 0, unchecked: 3, beyond: 1,
      place: 'Авачинский', zoneAssessed: true,
    });
    // Свободные даты при пробеле «на сейчас» уже не судятся: прогноз спрошен только о дате отказа.
    expect(forecast).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[date-check] тур 42: не проверено дат — 3: статус главного места устарел');
  });

  it('у тура нет главного места или координат, место вне сводок края или без зоны — «нет данных», и это видно в логе отдельной строкой', async () => {
    expect(await checkTourDates(42, D13, [D14], deps({ place: async () => null }))).toEqual({ state: 'no_data', missing: ['place'] });
    expect(await checkTourDates(42, D13, [D14], deps({ site: async () => ({ ...SITE, lat: null, lng: null }) }))).toEqual({ state: 'no_data', missing: ['coords'] });
    expect(await checkTourDates(42, D13, [D14], deps({ site: async () => ({ ...SITE, lat: Number.NaN }) }))).toEqual({ state: 'no_data', missing: ['coords'] });
    expect(await checkTourDates(42, D13, [D14], deps({ place: async () => null, site: async () => ({ ...SITE, lat: null, lng: null }) })))
      .toEqual({ state: 'no_data', missing: ['coords', 'place'] });
    expect(warn).toHaveBeenCalledWith('[date-check] тур 42: не записаны координаты; не записано главное место — даты после отказа по погоде не проверяются');
    // Северные Курилы: зелёному там верить нечем, и «позже» этого не исправит — тоже «нет данных».
    expect(await checkTourDates(42, D13, [D14], deps({ place: async () => OUTSIDE }))).toEqual({ state: 'no_data', missing: ['place_sources'] });
    expect(warn).toHaveBeenCalledWith('[date-check] тур 42: главное место вне сводок края — даты после отказа по погоде не проверяются');
    // У места нет зоны: зональные предупреждения к нему не относятся ни одно — «предупреждений нет» про него не сказать.
    expect(await checkTourDates(42, D13, [D14], deps({ placeAlerts: alertsOf([], null) }))).toEqual({ state: 'no_data', missing: ['place_zone'] });
    expect(warn).toHaveBeenCalledWith('[date-check] тур 42: у главного места не записана зона — даты после отказа по погоде не проверяются');
  });

  it('предупреждения по главному месту не прочитались — «не проверено», а не «предупреждений нет»', async () => {
    const quiet = sources({ forecast: calm });
    const broken = async (): Promise<TourPlaceAlerts> => { throw Object.assign(new Error('boom'), { code: '08006' }); };
    expect(await checkTourDates(42, D13, [D14], deps({ sources: quiet, placeAlerts: broken })))
      .toEqual({ state: 'unchecked', why: ['предупреждения по главному месту не прочитались'] });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('предупреждения по главному месту не прочитались'), 'SQLSTATE=08006');
    // Статус места есть, а запрос предупреждений места не нашёл (скрыли между чтениями) — тоже не «нет».
    expect(await checkTourDates(42, D13, [D14], deps({ sources: quiet, placeAlerts: async () => null })))
      .toEqual({ state: 'unchecked', why: ['предупреждения по главному месту не прочитались'] });
    // При ветре на дату отказа причина названа, свободные даты — не проверены.
    expect(await checkTourDates(42, D13, [D14, D15], deps({ placeAlerts: broken })))
      .toMatchObject({ state: 'confirmed', risks: ['погода: ветер до 90 км/ч'], clear: [], unchecked: 2 });
  });
});

describe('checkTourDates: зона «на сейчас»', () => {
  it('у оцениваемой зоны нет действующей оценки, она не прочиталась или бросила — «не проверено», каждое своими словами', async () => {
    const quiet = (zone: SituationSources['zone']) => deps({ sources: sources({ forecast: calm, zone }) });
    expect(await checkTourDates(42, D13, [D14], quiet(async () => null)))
      .toEqual({ state: 'unchecked', why: ['у зоны нет действующей оценки опасности'] });
    expect(warn).toHaveBeenCalledWith('[date-check] тур 42: даты после отказа по погоде не проверены — у зоны нет действующей оценки опасности');
    expect(await checkTourDates(42, D13, [D14], quiet(async () => 'failed')))
      .toEqual({ state: 'unchecked', why: ['оценка опасности зоны не прочиталась'] });
    expect(await checkTourDates(42, D13, [D14], quiet(async () => { throw Object.assign(new Error('boom'), { code: '57014' }); })))
      .toEqual({ state: 'unchecked', why: ['оценка опасности зоны не прочиталась'] });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('оценка опасности зоны не прочиталась'), 'SQLSTATE=57014');
  });

  it('зона без оценки при ветре на дату отказа: причина названа, свободные даты — не проверены', async () => {
    expect(await checkTourDates(42, D13, [D14, D15], deps({ sources: sources({ zone: async () => null }) })))
      .toMatchObject({ state: 'confirmed', risks: ['погода: ветер до 90 км/ч'], clear: [], unchecked: 2 });
  });

  it('у зоны вне модели оценка в проверку не входит и не спрашивается', async () => {
    const zone = vi.fn(async () => null);
    const far = deps({ site: async () => ({ ...SITE, zone: 'krai_koryak' }), sources: sources({ zone }) });
    expect(await checkTourDates(42, D13, [D14], far)).toMatchObject({ state: 'confirmed', clear: [D14], zoneAssessed: false });
    expect(zone).not.toHaveBeenCalled();
  });

  it('высокая или критическая опасность зоны — «сейчас», отдельным исходом, а не «опасное на вашу дату»', async () => {
    const forecast = vi.fn(async (): Promise<ForecastResult> => ({ ok: true, days: DAYS }));
    for (const level of ['high', 'critical'] as const) {
      const src = sources({ forecast, zone: async () => ({ name: 'Авачинско-Петропавловский', level }) });
      expect(await checkTourDates(42, D13, [D14, D15], deps({ sources: src })))
        .toEqual({ state: 'zone_risk', zone: 'Авачинско-Петропавловский', level });
    }
    // Оценка живёт часы: о дате она не говорит, и прогноз по датам не спрашивается.
    expect(forecast).not.toHaveBeenCalled();
    // Умеренная — не препятствие и не «опасное на дату».
    const moderate = sources({ zone: async () => ({ name: 'Авачинско-Петропавловский', level: 'moderate' }) });
    expect(await checkTourDates(42, D13, [D14], deps({ sources: moderate })))
      .toEqual({ state: 'confirmed', risks: ['погода: ветер до 90 км/ч'], clear: [D14], risk: 0, unchecked: 0, beyond: 0, place: 'Авачинский', zoneAssessed: true });
  });
});

describe('checkTourDates: «не смог проверить» не сходит за «чисто»', () => {
  it('прогноз из запаса (источник не ответил) — дата отказа не проверена', async () => {
    const stale = async (): Promise<ForecastResult> => ({ ok: true, days: DAYS, staleSince: '2027-01-11T20:00:00.000Z' });
    const r = await checkTourDates(42, D13, [D14], deps({ sources: sources({ forecast: stale }) }));
    expect(r).toEqual({ state: 'unchecked', why: [expect.stringContaining('есть только прогноз от 2027-01-11T20:00:00.000Z')] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('есть только прогноз от'));
  });

  it('прогноз не загрузился, бросил или в нём нет ветра — не проверено', async () => {
    for (const forecast of [
      async (): Promise<ForecastResult> => ({ ok: false, reason: 'источник не ответил' }),
      async (): Promise<ForecastResult> => { throw new Error('timeout'); },
      async (): Promise<ForecastResult> => ({ ok: true, days: [day(D13, null)] }),
    ]) {
      expect(await checkTourDates(42, D13, [D14], deps({ sources: sources({ forecast }) }))).toMatchObject({ state: 'unchecked' });
    }
  });

  it('прогноза на дату отказа нет, а предупреждение по месту действует — причина названа: известная опасность главнее', async () => {
    const down = async (): Promise<ForecastResult> => ({ ok: false, reason: 'источник не ответил' });
    const r = await checkTourDates(42, D13, [D14], deps({ sources: sources({ forecast: down }), placeAlerts: alertsOf([placeAlert()]) }));
    expect(r).toMatchObject({ state: 'confirmed', risks: ['официальное предупреждение: Жёлтый уровень: сильный ветер'], clear: [], unchecked: 1 });
  });

  it('общая лента не прочиталась или бросила — «не проверено»; при ветре на дату отказа свободные даты не проверены', async () => {
    expect(await checkTourDates(42, D13, [D14], deps({ sources: sources({ forecast: calm, officials: async () => 'failed' }) })))
      .toEqual({ state: 'unchecked', why: ['официальные предупреждения — лента не прочиталась'] });
    const thrown = sources({ officials: async () => { throw Object.assign(new Error('boom'), { code: '08006' }); } });
    expect(await checkTourDates(42, D13, [D14], deps({ sources: thrown })))
      .toMatchObject({ state: 'confirmed', risks: ['погода: ветер до 90 км/ч'], clear: [], unchecked: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('лента предупреждений не прочиталась'), 'SQLSTATE=08006');
  });

  it('действует серьёзное предупреждение, место которого не установлено, — дата не проверена, а не «чисто»', async () => {
    const lost = alert({ id: 7, affected_zones: [], expires_at: '2027-01-15T00:00:00+12:00' });
    const d = deps({ sources: sources({ officials: async () => [lost] }) });
    // 13.01 — ветер (причина есть). 14.01 — предупреждение без места ещё действует; 15.01 — уже нет.
    expect(await checkTourDates(42, D13, [D14, D15], d)).toMatchObject({ state: 'confirmed', clear: [D15], unchecked: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('действует официальное предупреждение, место которого не установлено'));
    // На дате отказа опасного не найдено, но такое предупреждение действует — «не проверено», а не «оператор знает больше».
    const quiet = sources({ forecast: calm, officials: async () => [lost] });
    expect(await checkTourDates(42, D14, [D15], deps({ sources: quiet }))).toEqual({
      state: 'unchecked', why: ['действует официальное предупреждение, место которого не установлено'],
    });
  });

  it('предупреждение с установленным местом в общей ленте проверку не гасит: закрытие парка, дорога, пожар, вулкан, далёкое землетрясение', async () => {
    const until = '2027-01-20T00:00:00+12:00';
    const placed = [
      alert({ id: 11, alert_type: 'park_closure', affected_zones: [], affected_parks: ['nalychevo'], expires_at: until }),
      alert({ id: 12, alert_type: 'road_closure', affected_zones: [], lat: '52.72', lng: '158.20', expires_at: until }),
      alert({ id: 13, alert_type: 'fire_danger', affected_zones: [], lat: 54.1, lng: 159.9, expires_at: until }),
      alert({ id: 14, alert_type: 'volcanic_eruption', affected_zones: [], volcano_ark_id: '6f1c0e1e-0000-4000-8000-000000000001', expires_at: until }),
      alert({ id: 15, alert_type: 'earthquake', severity: 3, affected_zones: [], lat: 49.5, lng: 156.0, expires_at: until }),
    ];
    for (const a of placed) {
      const src = sources({ officials: async () => [a] });
      // 13.01 — ветер: причина есть, и свободные даты не тонут в «не проверено».
      expect(await checkTourDates(42, D13, [D14, D15], deps({ sources: src })), a.alert_type)
        .toMatchObject({ state: 'confirmed', clear: [D14, D15], unchecked: 0 });
      // На спокойной дате отказа — «в данных причины нет», а не «не удалось проверить».
      expect(await checkTourDates(42, D14, [D15], deps({ sources: src })), a.alert_type).toMatchObject({ state: 'unconfirmed' });
    }
  });

  it('сбой прогноза на одной дате остальные не роняет, и «чисто» она не становится', async () => {
    let n = 0;
    // Прогноз спрашивается на каждую дату: вторая (14.01) падает.
    const flaky = sources({ forecast: async () => { n += 1; if (n === 2) throw new Error('обрыв'); return { ok: true, days: DAYS }; } });
    const r = await checkTourDates(42, D13, [D14, D15], deps({ sources: flaky }));
    expect(r).toMatchObject({ state: 'confirmed', clear: [D15], unchecked: 1 });
  });

  it('обстановка на дате не посчиталась (битая строка ленты) — не проверено, а не «чисто»', async () => {
    // Срок предупреждения не приводится к дате: сверка с лентой бросает на любой дате.
    const broken = alert({ affected_zones: [], expires_at: Symbol('битая строка') as unknown as string });
    const r = await checkTourDates(42, D14, [D15], deps({ sources: sources({ officials: async () => [broken] }) }));
    expect(r).toEqual({ state: 'unchecked', why: [expect.stringContaining('обстановка не посчиталась')] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('обстановка не посчиталась'));
  });

  it('лента, оценка зоны и предупреждения места читаются один раз на проверку, а не на каждую дату', async () => {
    const officials = vi.fn(async () => []);
    const zone = vi.fn(async () => ({ name: 'Авачинско-Петропавловский', level: 'low' as const }));
    const placeAlerts = vi.fn(alertsOf());
    await checkTourDates(42, D13, [D12, D14, D15, D16], deps({ sources: sources({ officials, zone }), placeAlerts }));
    expect(officials).toHaveBeenCalledTimes(1);
    expect(zone).toHaveBeenCalledTimes(1);
    expect(placeAlerts).toHaveBeenCalledTimes(1);
    expect(placeAlerts).toHaveBeenCalledWith(42);
  });

  it('тура нет или он не прочитался — не проверено, причина в логе', async () => {
    expect(await checkTourDates(42, D13, [D14], deps({ site: async () => null }))).toEqual({ state: 'unchecked', why: ['тур не найден'] });
    expect(await checkTourDates(42, D13, [D14], deps({ site: async () => { throw new Error('нет связи'); } })))
      .toEqual({ state: 'unchecked', why: [expect.stringContaining('тур не прочитался')] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('тур не найден'));
  });
});
