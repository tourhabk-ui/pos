/**
 * Слой хода экрана «На маршруте»: сколько осталось, когда придём, как далеко ушли.
 *
 * Владелец 09.08 по скрину экрана: «31.6 км до точки 1 из 2 без ETA и без
 * „сколько уже прошли“ — турист не понимает, идти ли ещё пять часов или это
 * автопереезд», а «0ч 00м» читается как поломка. Здесь — вся арифметика хода,
 * отдельно от компонента: её можно проверить тестами, а не глазами в поле.
 *
 * Модель — практический гибрид Нейсмита (владелец, 09.08):
 *   t = дистанция/база + набор/600 + сброс/1500
 * База для Камчатки — 3.5 км/ч, а не «спортивные» 5: тропа, рюкзак, погода.
 * Живой темп GPS подмешивается к модели, а не заменяет её: модель не знает
 * усталости и грязи, зато не «взрывается» на привале у первой же фотопаузы.
 *
 * Честность важнее точности. Нет высот — время считается по дистанции и это
 * подписано; темп ещё не набран — так и сказано, вместо нулей на экране.
 */

export type TravelMode = 'foot' | 'car';

/** Базовая скорость пешком, км/ч. Правится сложностью маршрута. */
export const FOOT_BASE_KMH = 3.5;
/** Средняя по камчатским грунтовкам — не трасса. */
export const CAR_BASE_KMH = 40;

export interface EtaInput {
  distanceKm: number;
  /** Набор высоты на оставшемся куске, м. Нет данных — не выдумываем. */
  ascentM?: number | null;
  descentM?: number | null;
  mode?: TravelMode;
  /** Пеший темп из GPS, км/ч. null — ещё не набран или потерян фикс. */
  recentPaceKmh?: number | null;
  /** Погодный множитель из `weatherFactor`. */
  weatherK?: number;
  /** Сложность маршрута правит базовую скорость (easy/medium/hard). */
  difficulty?: string | null;
}

export interface EtaResult {
  hours: number | null;
  /** Из чего сложилось время — на экране это подпись под цифрой. */
  basis: 'model' | 'pace+model';
  /** Рельеф учтён? Нет — подпись «без учёта рельефа». */
  reliefUsed: boolean;
}

/** База пешком по сложности: лёгкий быстрее, сложный с рюкзаком медленнее. */
export function baseSpeedKmh(mode: TravelMode, difficulty?: string | null): number {
  if (mode === 'car') return CAR_BASE_KMH;
  if (difficulty === 'easy') return 4.2;
  if (difficulty === 'hard') return 3.0;
  return FOOT_BASE_KMH;
}

/**
 * Темп из GPS считается по окну, а не «мгновенно»: мгновенная скорость в
 * начале движения скачет, а на привале падает в ноль — и ETA то удваивается,
 * то уходит в бесконечность. Значения вне разумного для пешего хода
 * отбрасываются: телепорт GPS не должен становиться прогнозом.
 */
export function isUsablePace(paceKmh: number | null | undefined, mode: TravelMode = 'foot'): boolean {
  if (typeof paceKmh !== 'number' || !Number.isFinite(paceKmh)) return false;
  return mode === 'car' ? paceKmh > 3 && paceKmh < 130 : paceKmh > 0.5 && paceKmh < 8;
}

export function etaHours(input: EtaInput): EtaResult {
  const mode: TravelMode = input.mode ?? 'foot';
  const distanceKm = Number(input.distanceKm);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return { hours: null, basis: 'model', reliefUsed: false };
  }

  const base = baseSpeedKmh(mode, input.difficulty);
  const ascent = typeof input.ascentM === 'number' && input.ascentM > 0 ? input.ascentM : 0;
  const descent = typeof input.descentM === 'number' && input.descentM > 0 ? input.descentM : 0;
  // Рельеф правит только пеший ход: на машине набор высоты времени не меняет.
  const reliefUsed = mode === 'foot' && (ascent > 0 || descent > 0);
  const model = distanceKm / base + (reliefUsed ? ascent / 600 + descent / 1500 : 0);

  const k = clampWeatherK(input.weatherK);

  if (isUsablePace(input.recentPaceKmh, mode)) {
    const byPace = distanceKm / (input.recentPaceKmh as number);
    // Погода уже частично «сидит» в живом темпе — множитель ослаблен, иначе
    // насчитаем её дважды (владелец 09.08).
    const hours = 0.6 * byPace + 0.4 * (model * Math.min(k, 1.25));
    return { hours, basis: 'pace+model', reliefUsed };
  }

  return { hours: model * k, basis: 'model', reliefUsed };
}

/** «4 ч 20 м». Ложной точности до минуты на длинном плече не показываем. */
export function formatEta(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return '—';
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} мин`;
  // На плечах длиннее двух часов минуты — вымысел: округляем до пяти.
  const mm = h >= 2 ? Math.round(m / 5) * 5 : m;
  return mm === 60 ? `${h + 1} ч` : mm === 0 ? `${h} ч` : `${h} ч ${mm} мин`;
}

/* ─── Погода: ограниченный множитель, а не второй прогноз ─────────────────── */

export interface WeatherSnap {
  precipMmH?: number | null;
  windMs?: number | null;
  visibilityM?: number | null;
  tempC?: number | null;
  snowDepthCm?: number | null;
  hasStormAlert?: boolean;
}

export interface WeatherFactor {
  k: number;
  /** Что именно замедляет — короткой строкой под цифрой. */
  notes: string[];
  /**
   * Выход не рекомендован. Это НЕ время: гроза и штормовой ветер — решение
   * safety-слоя «идти или не идти», а не «идти дольше» (владелец 09.08).
   */
  block: boolean;
}

/** Потолок множителя: без него 30 км превращаются в фантастику. */
export const WEATHER_K_MAX = 1.6;

function clampWeatherK(k: number | undefined): number {
  if (typeof k !== 'number' || !Number.isFinite(k) || k < 1) return 1;
  return Math.min(k, WEATHER_K_MAX);
}

export function weatherFactor(w: WeatherSnap | null | undefined): WeatherFactor {
  if (!w) return { k: 1, notes: [], block: false };

  const precip = num(w.precipMmH);
  const wind = num(w.windMs);
  const snow = num(w.snowDepthCm);

  if (w.hasStormAlert === true || precip >= 5 || wind >= 20) {
    return { k: 1, notes: ['выход не рекомендован'], block: true };
  }

  let extra = 0;
  const notes: string[] = [];

  if (precip >= 2) { extra += 0.25; notes.push('сильный дождь'); }
  else if (precip >= 0.3) { extra += 0.1; notes.push('дождь'); }

  if (wind >= 15) { extra += 0.25; notes.push('сильный ветер'); }
  else if (wind >= 8) { extra += 0.1; notes.push('ветер'); }

  const vis = w.visibilityM;
  if (typeof vis === 'number' && Number.isFinite(vis) && vis < 200) {
    extra += 0.15; notes.push('плохая видимость');
  }

  if (snow >= 10) { extra += 0.3; notes.push('снег'); }
  else if (snow >= 3) { extra += 0.15; notes.push('мокрый снег'); }

  const t = w.tempC;
  if (typeof t === 'number' && Number.isFinite(t) && t <= -10) { extra += 0.15; notes.push('мороз'); }

  return { k: Math.min(1 + extra, WEATHER_K_MAX), notes, block: false };
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/* ─── Темп из следа GPS ───────────────────────────────────────────────────── */

export interface TrackSample { lat: number; lng: number; t: number }

/** Расстояние по большому кругу, км. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Темп нужно ЗАРАБОТАТЬ: меньше этого окна — на экране «темп уточняется». */
export const PACE_MIN_WINDOW_S = 600;

/**
 * Темп по окну последних минут. Возвращает null, пока данных мало, — экран
 * тогда честно говорит «темп появится через 2–3 минуты» вместо «0ч 00м».
 */
export function paceFromTrack(
  samples: TrackSample[],
  windowSeconds = 900,
  now?: number,
): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const end = now ?? sorted[sorted.length - 1].t;
  const from = end - windowSeconds * 1000;
  const win = sorted.filter(s => s.t >= from);
  if (win.length < 2) return null;

  const spanS = (win[win.length - 1].t - win[0].t) / 1000;
  if (spanS < PACE_MIN_WINDOW_S) return null;

  let km = 0;
  for (let i = 1; i < win.length; i++) {
    const d = haversineKm(win[i - 1].lat, win[i - 1].lng, win[i].lat, win[i].lng);
    const dtS = (win[i].t - win[i - 1].t) / 1000;
    if (dtS <= 0) continue;
    // Телепорт GPS: скачок быстрее 40 км/ч между соседними отсчётами пешего
    // трека — это ошибка позиционирования, а не движение.
    if (d / (dtS / 3600) > 40) continue;
    km += d;
  }
  const pace = km / (spanS / 3600);
  return Number.isFinite(pace) ? pace : null;
}

/* ─── Прогресс по маршруту ────────────────────────────────────────────────── */

export interface RouteProgress {
  totalKm: number;
  doneKm: number;
  percent: number;
}

/**
 * Пройдено считается по линии маршрута: сумма плеч до текущей точки плюс то,
 * что съедено внутри текущего плеча. «Сколько уже прошли» — второе из трёх
 * чисел хода; без него большая цифра «осталось» ничего не говорит о ходе.
 */
export function routeProgress(
  legKms: number[],
  currentLegIdx: number,
  distanceToNextKm: number | null,
): RouteProgress {
  const legs = (legKms ?? []).filter(v => Number.isFinite(v) && v >= 0);
  const totalKm = legs.reduce((s, v) => s + v, 0);
  if (totalKm <= 0) return { totalKm: 0, doneKm: 0, percent: 0 };

  const idx = Math.max(0, Math.min(currentLegIdx, legs.length));
  let doneKm = legs.slice(0, idx).reduce((s, v) => s + v, 0);

  const leg = legs[idx];
  if (leg != null && typeof distanceToNextKm === 'number' && Number.isFinite(distanceToNextKm)) {
    // Турист может стоять дальше от точки, чем длина плеча (ушёл в сторону или
    // ещё не вышел на трек) — тогда внутри плеча пройдено ноль, а не минус.
    doneKm += Math.max(0, Math.min(leg, leg - distanceToNextKm));
  }

  const clamped = Math.max(0, Math.min(totalKm, doneKm));
  return { totalKm, doneKm: clamped, percent: Math.round((clamped / totalKm) * 100) };
}
