/**
 * Доверие к приборам экрана «На маршруте».
 *
 * Владелец 09.08: «это же навигация без связи и может спасти либо убить
 * человека». Отсюда правило этого модуля: прибор обязан отличать «я знаю» от
 * «я показываю последнее, что видел». Уверенная стрелка и уверенная цифра при
 * мёртвом датчике опаснее пустого экрана — пустой экран заставляет достать
 * карту, а врущий не заставляет ничего.
 *
 * Аудит того же дня нашёл ровно эти умолчания:
 *   - `pos.timestamp` и `pos.coords.accuracy` не использовались нигде: после
 *     потери фикса экран вечно показывал последнюю позицию как живую;
 *   - разрешение на компас на iOS не запрашивалось, и стрелка навсегда
 *     оставалась в нуле, то есть «на север» при любом повороте телефона;
 *   - относительный азимут части Android выдавался за истинный;
 *   - переход на следующую точку срабатывал при 50 м, хотя фикс мог иметь
 *     точность 300 м.
 */

/** Фикс старше этого — уже не «сейчас», а «последнее известное». */
export const FIX_STALE_MS = 30_000;
/** Старше этого — цифрам верить нельзя, их положено гасить. */
export const FIX_DEAD_MS = 120_000;
/** Хуже этой точности фикс не годится для решения «мы дошли». */
export const ARRIVAL_MAX_ACCURACY_M = 50;

export type FixState = 'live' | 'stale' | 'dead' | 'none';

export interface FixInfo {
  state: FixState;
  /** Возраст фикса в секундах — показывается словами, а не числом в консоли. */
  ageSeconds: number | null;
  accuracyM: number | null;
}

export function fixInfo(
  timestamp: number | null | undefined,
  accuracyM: number | null | undefined,
  now: number,
): FixInfo {
  const acc = typeof accuracyM === 'number' && Number.isFinite(accuracyM) && accuracyM > 0
    ? accuracyM
    : null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return { state: 'none', ageSeconds: null, accuracyM: acc };
  }
  const ageMs = Math.max(0, now - timestamp);
  const ageSeconds = Math.round(ageMs / 1000);
  if (ageMs >= FIX_DEAD_MS) return { state: 'dead', ageSeconds, accuracyM: acc };
  if (ageMs >= FIX_STALE_MS) return { state: 'stale', ageSeconds, accuracyM: acc };
  return { state: 'live', ageSeconds, accuracyM: acc };
}

/** Человеческая подпись под цифрами: что именно сейчас знает прибор. */
export function fixLabel(info: FixInfo): string {
  switch (info.state) {
    case 'none': return 'GPS не получен';
    case 'dead': return `Сигнал потерян ${formatAge(info.ageSeconds)} назад — цифры устарели`;
    case 'stale': return `Последний сигнал ${formatAge(info.ageSeconds)} назад`;
    case 'live':
      return info.accuracyM != null
        ? `GPS: точность ${Math.round(info.accuracyM)} м`
        : 'GPS: сигнал есть';
  }
}

export function formatAge(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds} с`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}

/**
 * Показывать ли расстояние и время как действующие. На мёртвом фиксе цифра
 * остаётся на экране, но помечается устаревшей: убирать её нельзя — это
 * последнее, что человек знает о своём положении.
 */
export function figuresAreLive(info: FixInfo): boolean {
  return info.state === 'live' || info.state === 'stale';
}

/**
 * «Мы дошли до точки» — решение, которое двигает весь маршрут вперёд, поэтому
 * оно принимается только по фиксу, которому можно верить. Точность 300 м
 * означает, что человек может стоять в трёхстах метрах от точки: перевести
 * маршрут на следующую — значит увести его от цели.
 */
export function canAdvanceWaypoint(info: FixInfo, distanceKm: number, thresholdKm = 0.05): boolean {
  if (info.state !== 'live') return false;
  if (info.accuracyM != null && info.accuracyM > ARRIVAL_MAX_ACCURACY_M) return false;
  return Number.isFinite(distanceKm) && distanceKm < thresholdKm;
}

/* ─── Компас ──────────────────────────────────────────────────────────────── */

/**
 * `unconfirmed` — датчик что-то шлёт, но это не подтверждённый истинный север
 * (Android без `absolute`): азимут может быть смещён на неизвестный угол.
 * `blocked` — iOS ждёт разрешения по жесту пользователя.
 */
export type CompassState = 'ok' | 'unconfirmed' | 'blocked' | 'off';

export function compassLabel(state: CompassState): string {
  switch (state) {
    case 'ok': return 'Компас: истинный север';
    case 'unconfirmed': return 'Компас не подтверждён — сверяйтесь с картой';
    case 'blocked': return 'Компас выключен — включите, чтобы видеть направление';
    case 'off': return 'Компас недоступен на этом устройстве';
  }
}

/**
 * Событие ориентации → азимут и степень доверия.
 *
 * iOS отдаёт `webkitCompassHeading` — это истинный север, ему верим. Прочие
 * устройства дают `alpha`, но только с флагом `absolute` он привязан к земной
 * системе координат; без флага это отсчёт от случайной начальной ориентации,
 * и выдавать его за азимут нельзя.
 */
export function readHeading(
  e: {
    alpha?: number | null;
    absolute?: boolean;
    webkitCompassHeading?: number;
  },
  /**
   * Событие пришло из земной системы координат по самому своему типу.
   * `deviceorientationabsolute` по спецификации абсолютное — но Chrome на
   * части Android не ставит в нём флаг `absolute`. Без этой поправки честный
   * азимут с магнитометра объявлялся неподтверждённым (владелец 09.08:
   * «компас не подтверждён, что за баг?»).
   */
  earthFrame = false,
): { heading: number; state: 'ok' | 'unconfirmed' } | null {
  const wk = e.webkitCompassHeading;
  if (typeof wk === 'number' && Number.isFinite(wk)) {
    return { heading: ((wk % 360) + 360) % 360, state: 'ok' };
  }
  if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    const heading = ((360 - e.alpha) % 360 + 360) % 360;
    return { heading, state: e.absolute === true || earthFrame ? 'ok' : 'unconfirmed' };
  }
  return null;
}

/** Нужен ли жест пользователя, чтобы включить компас (iOS 13+). */
export function compassNeedsPermission(): boolean {
  if (typeof window === 'undefined') return false;
  const ctor = (window as unknown as {
    DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
  }).DeviceOrientationEvent;
  return typeof ctor?.requestPermission === 'function';
}

/* ─── Порог «я в стороне от тропы» ──────────────────────────────────────── */

/**
 * Пол и потолок порога отхода от тропы, метры.
 *
 * Порог был константой в сто метров, и это ошибка в опасную сторону при плохом
 * небе: при точности +-60 м человек, идущий ровно по тропе, регулярно
 * оказывается «в стороне». Ложное «вы в стороне» гонит его искать тропу,
 * которой он и так держится, — то есть сход с маршрута, устроенный прибором.
 *
 * Пол в двадцать пять метров нужен с другой стороны: при отличном небе
 * (+-5 м) порог в десять метров объявлял бы отходом каждый обход лужи.
 * Потолок в сто двадцать — граница, за которой «на тропе» перестаёт что-либо
 * значить: сто двадцать метров в камчатском стланике это уже не тропа.
 */
export const OFF_TRACK_FLOOR_M = 25;
export const OFF_TRACK_CEIL_M = 120;

/** Во сколько раз порог шире заявленной точности. */
export const OFF_TRACK_ACCURACY_FACTOR = 2;

/**
 * Порог отхода от тропы по текущей точности фикса.
 *
 * Точность неизвестна — берётся потолок, а не пол: не знать, насколько врёт
 * датчик, и при этом строго судить человека — худшее из сочетаний.
 *
 * Важно, чего этот порог НЕ касается. Он про вопрос «я на тропе?», то есть
 * про GPS. Вопрос «путевая точка стоит на треке?» — про данные маршрута, и
 * GPS к нему отношения не имеет; общий порог склеил бы две разные природы
 * обратно в одну (см. DATA_CONFLICT_KM в lib/on-route/approach).
 */
export function offTrackThresholdM(accuracyM: number | null): number {
  if (accuracyM == null || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    return OFF_TRACK_CEIL_M;
  }
  return Math.min(
    OFF_TRACK_CEIL_M,
    Math.max(OFF_TRACK_FLOOR_M, accuracyM * OFF_TRACK_ACCURACY_FACTOR),
  );
}

/**
 * Годится ли фикс для навигационных решений — проекции и отхода от тропы.
 *
 * Порог тот же, что у перехода на следующую точку (ARRIVAL_MAX_ACCURACY_M):
 * заводить второе понятие «плохой фикс» значило бы получить два ответа на
 * один вопрос.
 *
 * Отдельно про то, чего делать НЕЛЬЗЯ. Отбросить плохой фикс и молча оставить
 * на экране прежнюю проекцию — это стухшее значение под видом текущего. Такой
 * фикс не двигает положение, но экран обязан сказать, что показывает
 * последнее известное: для этого уже есть fixInfo и figuresAreLive, и новой
 * сущности заводить не надо.
 */
export function fixUsableForNavigation(accuracyM: number | null): boolean {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return false;
  return accuracyM <= ARRIVAL_MAX_ACCURACY_M;
}

/**
 * Точность хуже этого — не GPS. Браузер отдаёт `coords` и с сетевой/IP-
 * геолокацией, когда спутников не видно: `accuracy` в таких фиксах бывает
 * ±десятки километров, `timestamp` — только что, и по одной свежести
 * (`fixInfo`/`figuresAreLive`) такой фикс неотличим от настоящего GPS.
 * Живой скрин владельца 29.08: точность ±64642 м, дистанция до точки —
 * «7921 км» вместо честного «сигнала нет».
 *
 * Это НЕ второй порог для того же вопроса, что у `fixUsableForNavigation`
 * (комментарий там прямо предупреждает: два ответа на один вопрос — путаница).
 * Тот порог (50 м) отвечает «можно ли доверять фиксу для манёвра — переход
 * точки, поворот». Этот отвечает на другой вопрос: «это вообще положение
 * человека, или сетевая догадка в масштабе города». Ответ на первый вопрос
 * не имеет смысла, пока не дан честный ответ на этот.
 */
export const GPS_ACCURACY_IMPLAUSIBLE_M = 5000;

export function fixAccuracyPlausible(accuracyM: number | null): boolean {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return true;
  return accuracyM <= GPS_ACCURACY_IMPLAUSIBLE_M;
}
