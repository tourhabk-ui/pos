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

export function requestPosition(opts: GeoOptions = {}): Promise<GeoResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({ ok: false, kind: 'unsupported' });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
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
