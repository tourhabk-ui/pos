/**
 * Запрос своего местоположения — с честным ответом, почему не вышло.
 *
 * Владелец 09.08: «геоточки не работают» — кнопка «Моё местоположение» на
 * радаре. В коде было восемь мест, каждое со своими настройками, и у кнопки
 * оказались худшие: восьмисекундный таймаут (холодный фикс на телефоне часто
 * дольше), без запроса точности и с одним исходом на все беды — «недоступна».
 * Таймаут лечится повтором, запрет — настройками браузера, отсутствие датчика
 * не лечится ничем: сводить их в одну фразу значит не давать человеку выхода.
 *
 * Здесь один вход с разумными значениями по умолчанию и разбором причины.
 */

export type GeoFailure = 'unsupported' | 'denied' | 'unavailable' | 'timeout';

export type GeoResult =
  | { ok: true; lat: number; lng: number; accuracyM: number | null }
  | { ok: false; kind: GeoFailure };

export interface GeoOptions {
  /** Холодный фикс на телефоне занимает секунды: даём время, а не отказ. */
  timeoutMs?: number;
  highAccuracy?: boolean;
  /** Свежий кэш позиции экономит и время, и батарею. */
  maxAgeMs?: number;
}

export const GEO_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Геолокация, которой можно пользоваться, — или null («устройство не умеет»).
 *
 * Объект `navigator.geolocation` есть не значит, что он рабочий: 23.10
 * карточка места упала у посетителя с «navigator.geolocation.watchPosition
 * is not a function» — объект был, функции не было (урезанные встроенные
 * браузеры и расширения приватности подменяют его заглушкой). Проверка
 * «есть ли объект» стояла в четырнадцати файлах и такой браузер пропускала.
 *
 * Проверка — по той функции, которая нужна, а не по всем сразу: у такого
 * браузера разовый запрос мог работать, и требовать от SOS слежения, чтобы
 * спросить место один раз, значило бы отнять у него координаты.
 */
type GeoOnce = Pick<Geolocation, 'getCurrentPosition'>;
type GeoWatch = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;

function rawGeolocation(): Partial<Geolocation> | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as { geolocation?: Partial<Geolocation> | null }).geolocation ?? null;
}

/** Разовый запрос места (getCurrentPosition). */
export function geolocationOnce(): GeoOnce | null {
  const geo = rawGeolocation();
  return geo && typeof geo.getCurrentPosition === 'function' ? (geo as GeoOnce) : null;
}

/** Слежение за местом (watchPosition + clearWatch: без второй слежку не остановить). */
export function geolocationWatch(): GeoWatch | null {
  const geo = rawGeolocation();
  return geo && typeof geo.watchPosition === 'function' && typeof geo.clearWatch === 'function'
    ? (geo as GeoWatch)
    : null;
}

export function requestPosition(opts: GeoOptions = {}): Promise<GeoResult> {
  const geo = geolocationOnce();
  if (!geo) {
    return Promise.resolve({ ok: false, kind: 'unsupported' });
  }
  return new Promise((resolve) => {
    geo.getCurrentPosition(
      (p) => resolve({
        ok: true,
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracyM: typeof p.coords.accuracy === 'number' ? p.coords.accuracy : null,
      }),
      (err) => {
        // Коды по спецификации: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE,
        // 3 TIMEOUT. Раньше все три давали одну фразу.
        const kind: GeoFailure =
          err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
        resolve({ ok: false, kind });
      },
      {
        enableHighAccuracy: opts.highAccuracy ?? true,
        timeout: opts.timeoutMs ?? GEO_DEFAULT_TIMEOUT_MS,
        maximumAge: opts.maxAgeMs ?? 60_000,
      },
    );
  });
}

/** Что сказать человеку — и что он может с этим сделать. */
export function geoFailureText(kind: GeoFailure): string {
  switch (kind) {
    case 'denied': return 'Доступ к геолокации запрещён — разрешите его в настройках браузера';
    case 'timeout': return 'Спутники не отвечают — попробуйте ещё раз, лучше под открытым небом';
    case 'unavailable': return 'Определить местоположение не удалось — сигнал не ловится';
    case 'unsupported': return 'Устройство не умеет определять местоположение';
  }
}
