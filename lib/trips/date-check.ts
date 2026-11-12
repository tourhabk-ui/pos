/**
 * Проверка дат тура после отказа «погода или безопасность» (план «после
 * отказа», этап 2в; слово владельца 11.11, вопрос 3).
 *
 * Владелец: другие варианты после такого отказа предлагать можно, только если
 * они безопасны на эту дату — «проверка обстановки и места, а не догадка», и
 * с объяснением человеку, почему замена. До этого шага дат после отказа по
 * погоде не было вовсе (2б): непроверенная дата под словами «вместо погоды»
 * была бы обещанием, которого система не держит.
 *
 * Своих порогов и своего правила «к кому относится предупреждение» здесь нет:
 *  - «на сейчас» — статус главного места тура (lib/safety/tour-place-status) и
 *    оценка опасности зоны (она живёт часы). О дате они не говорят — это
 *    условие: пока место закрыто, жёлтое или красное, а зона оценена высокой,
 *    проверенной нельзя назвать ни одну дату;
 *  - «на дату» — прогноз погоды в точке тура (`judgeForecastDay`, тот же, что
 *    у «Моей поездки» и напоминаний) и уже выпущенные официальные
 *    предупреждения, которые относятся к главному месту тура и действуют в
 *    этот день. К месту их относит тот же предикат, что красит статус места
 *    (lib/trips/tour-place-alerts): сравнение зон тура и предупреждения —
 *    правило Rescue — здесь не используется, три прохода ревью нашли в нём три
 *    разных способа сказать человеку неправду.
 *
 * Порядок и исходы (§4.0: «не смог проверить» нигде не равно «хорошо»):
 *  1. no_data — у тура нет координат или главного места, место вне сводок
 *     края либо у него не записана зона: проверять не по чему, и так будет,
 *     пока данные не появятся. Пишется в лог.
 *  2. past / beyond — дата отказа уже прошла или дальше прогноза: статусы «на
 *     сейчас» о ней не говорят, поэтому это решается раньше места и зоны.
 *  3. place_risk — главное место сейчас закрыто, красное или жёлтое.
 *  4. zone_risk — опасность в зоне сейчас оценена высокой или критической.
 *  5. confirmed — данные Ведара видят опасное на дату отказа: прогноз или
 *     предупреждение по месту, которое объясняет отказ по погоде
 *     (`explainsWeatherDecline`: уровень 2+ либо условия дня; постоянный режим
 *     уровня 1 причиной не называется). Оно и есть объяснение замены.
 *     Свободные даты судятся строже: clear — только без единого действующего
 *     предупреждения по месту; иначе risk / unchecked / beyond. Человеку
 *     называются только clear. Та ли это причина, что у оператора, Ведар не
 *     знает: выезд на любую дату подтверждает он.
 *  6. unchecked — опасного на дату отказа не найдено, но что-то проверить не
 *     удалось: статус места не пересчитан, источник не ответил, прогноз
 *     только из запаса, у оцениваемой зоны нет действующей оценки, действует
 *     предупреждение, место которого не установлено. Причина — в логе.
 *  7. unconfirmed — проверено всё, и причина отказа в данных Ведара не
 *     отражена. Значит, оператор знает то, чего в этих данных нет, и «чисто»
 *     у соседних дат по тем же данным ничего не стоит: дат не называем.
 *     Постоянный режим уровня 1, действующий на дату отказа, при этом не
 *     замалчивается: он отдаётся в `standing` и называется человеку как есть —
 *     «причина ли это отказа, Ведар не знает».
 *
 * Известная опасность главнее неизвестности: ветер на дату отказа называется
 * и тогда, когда оценка зоны или статус места не прочитались, — но ни одна
 * свободная дата при этом проверенной не считается.
 *
 * Слова «безопасно» здесь нет и быть не должно: Ведар называет, что проверил
 * и чего не нашёл; решение о выезде — за оператором.
 */
import { activeOn, judgeForecastDay, type OfficialAlert } from '@/lib/agents/evo/rescue-judge';
import { addDays } from '@/lib/bookings/duration';
import { logText } from '@/lib/log/log-text';
import { loadTourPlaceStatus, type TourPlaceStatus } from '@/lib/safety/tour-place-status';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { SITUATION_FORECAST_DAYS, judgeSituation, type ZoneDangerInput } from '@/lib/trips/situation';
import { isAssessedZone, liveSources, loadTourSite, type SituationSources, type TourSite } from '@/lib/trips/situation-store';
import { loadTourPlaceAlerts, type PlaceAlert, type TourPlaceAlerts } from '@/lib/trips/tour-place-alerts';

/** Суждение об одной дате в пределах прогноза. */
export type DateVerdict =
  | { verdict: 'clear' }
  | { verdict: 'risk'; risks: string[] }
  | { verdict: 'unchecked'; why: string[] };

/** Статус главного места тура: записан; места у тура нет (null); не прочитался. */
export type PlaceRead = TourPlaceStatus | null | 'failed';

export type PlaceVerdict =
  | { kind: 'ok' }
  | { kind: 'missing' }
  /** Место вне сводок края (Северные Курилы): зелёному там верить нечем — и так будет всегда. */
  | { kind: 'outside' }
  | { kind: 'risk'; level: 'closed' | 'red' | 'yellow' }
  | { kind: 'unchecked'; why: string };

/** Суждение о главном месте тура — чистая функция. Зелёный засчитывается только свежий. */
export function judgePlace(place: PlaceRead): PlaceVerdict {
  if (place === 'failed') return { kind: 'unchecked', why: 'статус главного места не прочитался' };
  if (place === null) return { kind: 'missing' };
  if (place.closed) return { kind: 'risk', level: 'closed' };
  if (place.level === 'red' || place.level === 'yellow') return { kind: 'risk', level: place.level };
  if (place.level === 'green') return { kind: 'ok' };
  if (place.stale) return { kind: 'unchecked', why: 'статус главного места устарел' };
  if (place.outside_sources) return { kind: 'outside' };
  return { kind: 'unchecked', why: 'статус главного места не рассчитан' };
}

/**
 * Установлено ли место предупреждения — так, чтобы предикат мест
 * (`ALERT_MATCH_SQL`) мог отнести его хоть к кому-то.
 *
 * Роды с точным местом (`PLACE_SCOPED_TYPES`, lib/services/safety/
 * alert-place-scope) зоной не судятся: дорога и пожар — координатой, извержение
 * и запрет у вулкана — вулканом, закрытие парка — парком. Привязки нет — такое
 * предупреждение не относится ни к одному месту, даже когда зона у него
 * записана. Остальные роды судятся зоной; землетрясение с координатой
 * эпицентра — силой сотрясения, место у него известно и без зон. Новый род в
 * `PLACE_SCOPED_TYPES` без ветки здесь — красный тест (date-check.test).
 */
export function alertPlaceKnown(a: OfficialAlert): boolean {
  const coords = a.lat != null && a.lng != null;
  switch (a.alert_type) {
    case 'road_closure':
    case 'fire_danger':
      return coords;
    case 'volcanic_eruption':
      return a.volcano_ark_id != null;
    case 'park_closure':
    case 'park_status_unknown':
      return (a.affected_parks ?? []).length > 0;
    default:
      return (a.affected_zones ?? []).length > 0 || (a.alert_type === 'earthquake' && coords);
  }
}

/**
 * Серьёзные предупреждения, место которых не установлено, действующие в этот
 * день. К местам они не относятся: «не установлено где» не значит «везде»
 * (решение владельца 27.09). Но и «тура не касается» про них сказать нельзя —
 * день под таким предупреждением проверенным не считается.
 *
 * Пустые зоны — ещё не «без места»: закрытие парка пишется без зон по
 * построению (#2133), его место — парк. Без этого различия одно действующее
 * закрытие делало бы непроверенной каждую дату у каждого тура (ревью 2в).
 */
export function unplacedAlertsOn(alerts: readonly OfficialAlert[], day: string): OfficialAlert[] {
  return alerts.filter((a) => a.severity >= 2 && !alertPlaceKnown(a) && activeOn(a, day));
}

/**
 * Роды «условий дня»: погода, вода, лавины, оползни, пепел. Предупреждение
 * уровня 1 такого рода («потенциально опасно») — причина отказа по погоде.
 */
const DAY_CONDITION_TYPES: ReadonlySet<string> = new Set(['weather', 'flood', 'avalanche', 'landslide', 'ash_cloud']);

/**
 * Объясняет ли предупреждение по месту отказ «погода или безопасность».
 *
 * Уровень 2 и выше — да, любого рода: это «опасно», закрытие или запрет.
 * Уровень 1 — только условия дня. Постоянный режим на уровне 1 («проезд по
 * пропускам», класс пожарной опасности, замеченный у посёлка медведь) причиной
 * НЕ называется: он действовал и когда человек оставлял заявку, и «По данным
 * Ведара на вашу дату: проезд по пропускам» под отказом по погоде было бы той
 * же ложной причиной, что запрет у чужого вулкана (ревью 2в, третий проход).
 *
 * Для свободной даты правило другое и строже: её держит ЛЮБОЕ действующее
 * предупреждение по месту — «не нашёл предупреждений» говорится буквально.
 */
export function explainsWeatherDecline(a: Pick<PlaceAlert, 'alert_type' | 'severity'>): boolean {
  return a.severity >= 2 || DAY_CONDITION_TYPES.has(a.alert_type ?? '');
}

/** Чего у тура нет, чтобы проверять вовсе. */
export type DateCheckMissing = 'coords' | 'place' | 'place_sources' | 'place_zone';

export type DateCheck =
  | { state: 'no_data'; missing: DateCheckMissing[] }
  /** Дата отказа уже прошла: сверять её не с чем. */
  | { state: 'past' }
  /** Дата отказа дальше прогноза. */
  | { state: 'beyond' }
  | { state: 'place_risk'; place: string; level: 'closed' | 'red' | 'yellow' }
  /** Опасность в зоне тура сейчас оценена высокой: это «на сейчас», а не «на дату». */
  | { state: 'zone_risk'; zone: string; level: 'high' | 'critical' }
  | { state: 'unchecked'; why: string[] }
  | {
    state: 'unconfirmed'; place: string; zoneAssessed: boolean;
    /**
     * Заголовки предупреждений по месту, действующих на дату отказа, которые
     * отказ по погоде не объясняют (постоянный режим уровня 1). Причиной они
     * не названы, но и не замалчиваются. Поля нет — таких предупреждений нет.
     */
    standing?: string[];
  }
  | {
    state: 'confirmed';
    /** Что данные Ведара называют опасным на дату отказа — объяснение замены. */
    risks: string[];
    /** Свободные даты, прошедшие проверку целиком, по возрастанию. */
    clear: string[];
    /** На скольких свободных датах найдена опасная погода или действующее предупреждение. */
    risk: number;
    /** Сколько свободных дат в пределах прогноза проверить не удалось. */
    unchecked: number;
    /** Сколько свободных дат вне прогноза. */
    beyond: number;
    place: string;
    /** Оценка опасности зоны входила в проверку: зона тура — из оцениваемых. */
    zoneAssessed: boolean;
  };

export interface DateCheckDeps {
  sources?: SituationSources;
  site?: typeof loadTourSite;
  place?: typeof loadTourPlaceStatus;
  placeAlerts?: typeof loadTourPlaceAlerts;
  now?: () => number;
}

const LOG = '[date-check]';
const errWords = (err: unknown) => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : logText(err instanceof Error ? err.message : err, 120);
};

const MISSING_WORDS: Record<DateCheckMissing, string> = {
  coords: 'не записаны координаты',
  place: 'не записано главное место',
  place_sources: 'главное место вне сводок края',
  place_zone: 'у главного места не записана зона',
};

/**
 * Проверка: видят ли данные Ведара причину отказа на дату `declined` и какие
 * из свободных дат `candidates` проходят ту же проверку. Не бросает: отказ
 * базы или источника — «не смог проверить» с причиной в логе.
 */
export async function checkTourDates(
  tourId: number, declined: string, candidates: readonly string[], deps: DateCheckDeps = {},
): Promise<DateCheck> {
  const now = (deps.now ?? Date.now)();
  const unchecked = (why: string[]): DateCheck => {
    console.warn(`${LOG} тур ${tourId}: даты после отказа по погоде не проверены — ${why.join('; ')}`);
    return { state: 'unchecked', why };
  };

  let site: TourSite | null;
  try {
    site = await (deps.site ?? loadTourSite)(tourId);
  } catch (err) {
    return unchecked([`тур не прочитался (${errWords(err)})`]);
  }
  if (!site) return unchecked(['тур не найден']);

  let placeRead: PlaceRead;
  try {
    placeRead = await (deps.place ?? loadTourPlaceStatus)(tourId, now);
  } catch (err) {
    console.error(`${LOG} тур ${tourId}: статус главного места не прочитался:`, errWords(err));
    placeRead = 'failed';
  }
  const place = judgePlace(placeRead);

  // Предупреждения по главному месту — тем же предикатом, что у статуса места.
  let placeAlerts: TourPlaceAlerts | null | 'failed' = null;
  if (place.kind !== 'missing') {
    try {
      placeAlerts = await (deps.placeAlerts ?? loadTourPlaceAlerts)(tourId);
    } catch (err) {
      console.error(`${LOG} тур ${tourId}: предупреждения по главному месту не прочитались:`, errWords(err));
      placeAlerts = 'failed';
    }
  }

  const missing: DateCheckMissing[] = [];
  const point = site.lat !== null && site.lng !== null && Number.isFinite(site.lat) && Number.isFinite(site.lng)
    ? { lat: site.lat, lng: site.lng } : null;
  if (!point) missing.push('coords');
  if (place.kind === 'missing') missing.push('place');
  if (place.kind === 'outside') missing.push('place_sources');
  // Без зоны зональные предупреждения к месту не относятся ни одно: «предупреждений нет» про него не сказать.
  if (placeAlerts !== null && placeAlerts !== 'failed' && placeAlerts.zone === null) missing.push('place_zone');
  if (missing.length > 0 || !point) {
    // Структурный ноль: такому туру даты не будут названы, пока данные не появятся, — это должно быть видно (§4.0).
    console.warn(`${LOG} тур ${tourId}: ${missing.map((m) => MISSING_WORDS[m]).join('; ')} — даты после отказа по погоде не проверяются`);
    return { state: 'no_data', missing };
  }

  // Статусы «на сейчас» и прогноз говорят только о ближайших днях: дальняя и
  // прошедшая дата решаются раньше места и зоны — иначе причина была бы названа не та.
  const today = kamchatkaToday(now);
  const last = addDays(today, SITUATION_FORECAST_DAYS - 1);
  const inForecast = (d: string) => d >= today && d <= last;
  if (declined < today) return { state: 'past' };
  if (declined > last) return { state: 'beyond' };

  // Что «на сейчас» проверить не удалось. Известной опасности это не заслоняет
  // (ниже), но ни одна свободная дата при таком пробеле проверенной не считается.
  const gaps: string[] = [];
  const placeName = placeRead !== null && placeRead !== 'failed' ? placeRead.place : '';
  if (place.kind === 'risk') return { state: 'place_risk', place: placeName, level: place.level };
  if (place.kind === 'unchecked') gaps.push(place.why);

  const src = deps.sources ?? liveSources();

  // Оценка опасности зоны — тоже «на сейчас»: о дате она не говорит, поэтому
  // судится здесь, а не вместе с датой (иначе «опасность в зоне» называлась бы
  // «на вашу дату», а все свободные даты — «с найденным опасным»).
  const zoneAssessed = isAssessedZone(site.zone);
  if (isAssessedZone(site.zone)) {
    let z: ZoneDangerInput | null | 'failed';
    try {
      z = await src.zone(site.zone);
    } catch (err) {
      console.error(`${LOG} тур ${tourId}: оценка опасности зоны не прочиталась:`, errWords(err));
      z = 'failed';
    }
    if (z === 'failed') gaps.push('оценка опасности зоны не прочиталась');
    else if (z === null) gaps.push('у зоны нет действующей оценки опасности');
    else if (z.level === 'high' || z.level === 'critical') return { state: 'zone_risk', zone: z.name, level: z.level };
  }

  // Общая лента — только ради предупреждений, место которых не установлено.
  let feed: OfficialAlert[] | 'failed';
  try {
    feed = await src.officials();
  } catch (err) {
    console.error(`${LOG} тур ${tourId}: лента предупреждений не прочиталась:`, errWords(err));
    feed = 'failed';
  }
  if (feed === 'failed') gaps.push('официальные предупреждения — лента не прочиталась');
  if (placeAlerts === 'failed' || placeAlerts === null) gaps.push('предупреждения по главному месту не прочитались');
  const known: PlaceAlert[] = placeAlerts !== null && placeAlerts !== 'failed' ? placeAlerts.alerts : [];
  const general: OfficialAlert[] = feed === 'failed' ? [] : feed;

  /**
   * Суждение об одной дате в пределах прогноза: прогноз и предупреждения по
   * месту, действующие в этот день. Слова — те же, что у «Моей поездки»
   * (`judgeSituation`). Прогноз из запаса (источник не ответил, отдан
   * последний удачный) — не «проверено сейчас»: считается незагруженным.
   */
  const judgeDate = async (date: string, role: 'declined' | 'free'): Promise<DateVerdict> => {
    try {
      let weather;
      try {
        const f = await src.forecast(point.lat, point.lng);
        weather = judgeForecastDay(
          f.ok && f.staleSince ? { ok: false, reason: `источник не ответил, есть только прогноз от ${f.staleSince}` } : f,
          date,
        );
      } catch (err) {
        weather = { kind: 'unknown' as const, reason: `прогноз не загрузился (${err instanceof Error ? logText(err.message, 80) : 'сбой'})` };
      }
      // Дате отказа причиной служит не всякое предупреждение (explainsWeatherDecline); свободную держит любое.
      const active = known.filter((a) => activeOn(a, date));
      const officials = (role === 'declined' ? active.filter(explainsWeatherDecline) : active).map((a): OfficialAlert => ({
        id: Number(a.id), alert_type: a.alert_type ?? '', severity: a.severity, title: a.title,
        description: null, affected_zones: null, expires_at: a.expires_at, source_url: null,
      }));
      const s = judgeSituation({ weather, officials, officialsUnassessed: false, zoneDanger: null });
      if (s.kind === 'risk') return { verdict: 'risk', risks: s.risks };
      if (s.kind !== 'calm') return { verdict: 'unchecked', why: s.unchecked };
      if (unplacedAlertsOn(general, date).length > 0) {
        return { verdict: 'unchecked', why: ['действует официальное предупреждение, место которого не установлено'] };
      }
      return { verdict: 'clear' };
    } catch (err) {
      return { verdict: 'unchecked', why: [`обстановка не посчиталась (${errWords(err)})`] };
    }
  };

  const own = await judgeDate(declined, 'declined');
  if (own.verdict !== 'risk') {
    const why = [...gaps, ...(own.verdict === 'unchecked' ? own.why : [])];
    if (why.length > 0) return unchecked(why);
    // Всё, что действует на дату отказа и до сюда дошло, отказ не объясняет (иначе был бы риск):
    // причиной не названо, но человеку сказано, что оно есть.
    const standing = known.filter((a) => activeOn(a, declined)).map((a) => a.title.replace(/\s+/g, ' ').trim());
    return { state: 'unconfirmed', place: placeName, zoneAssessed, ...(standing.length > 0 ? { standing } : {}) };
  }

  const out = { clear: [] as string[], risk: 0, unchecked: 0, beyond: 0 };
  const why = new Set<string>(gaps);
  for (const date of [...new Set(candidates)].sort()) {
    if (date === declined) continue;
    if (!inForecast(date)) { out.beyond += 1; continue; }
    // Пробел «на сейчас» — ни одна дата не проверена: прогноз о ней уже не спрашиваем.
    if (gaps.length > 0) { out.unchecked += 1; continue; }
    const v = await judgeDate(date, 'free');
    if (v.verdict === 'clear') out.clear.push(date);
    else if (v.verdict === 'risk') out.risk += 1;
    else { out.unchecked += 1; v.why.forEach((w) => why.add(w)); }
  }
  if (out.unchecked > 0) console.warn(`${LOG} тур ${tourId}: не проверено дат — ${out.unchecked}: ${[...why].join('; ')}`);
  return { state: 'confirmed', risks: own.risks, ...out, place: placeName, zoneAssessed };
}
