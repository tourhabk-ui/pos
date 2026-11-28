/**
 * Куда открыть карту обстановки по ссылке.
 *
 * Задача владельца 27.11 «Карта обстановки Ведара: точки с координатами и вход
 * из MAX»: ссылка из поста канала, от Кузьмича или из мини-приложения MAX
 * открывает ту же `/map` — на месте или со сводкой обстановки, — а не вторую
 * карту.
 *
 * Три входа, одно правило:
 *  - сайт: `/map?place=<id|slug>` и `/map?show=safety`;
 *  - мини-приложение MAX: `https://max.ru/<бот>?startapp=<payload>` — MAX
 *    кладёт payload в адрес страницы параметром `WebAppStartParam`
 *    (dev.max.ru/help/deeplinks, прочитано 27.11) и в `initData`. Здесь читается
 *    только адрес: моста MAX для этого не нужно;
 *  - payload: `map`, `map-safety`, `place-<ref>`, `volcano-<ref>` — до 512 знаков
 *    `[A-Za-z0-9_-]`, как требует MAX.
 *
 * Параметр — подсказка навигации, не доступ: место ищется в базе по ссылке, и
 * его опасности приходят оттуда же (docs/CHAT_MINIAPPS_PLAN.md §6.3). Чужое и
 * битое — обзор края, не ошибка. Модуль чистый и без сети: его зовут и сервер,
 * и браузер.
 */

/** Место, на котором открыть карту (заполняет сервер, lib/map/map-focus.ts). */
export interface MapFocusPlace {
  /** Id в пространстве `/api/places/[id]`: ark_id, без него — id места. */
  id: string;
  title: string;
  locationType: string | null;
  lat: number;
  lng: number;
}

/** Три исхода (§4.0): найдено; не найдено; не загрузилось. */
export type MapFocus =
  | { state: 'place'; place: MapFocusPlace }
  | { state: 'not_found' }
  | { state: 'failed' };

export type MapTarget =
  | { kind: 'overview' }
  | { kind: 'safety' }
  | { kind: 'place'; ref: string };

/** Payload мини-приложения MAX: до 512 знаков, латиница, цифры, `_` и `-`. */
export const START_PARAM_RE = /^[A-Za-z0-9_-]{1,512}$/;
/** Ссылка на место: id, ark_id или slug — те же знаки, длина с запасом. */
const PLACE_REF_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** Параметр адреса, которым MAX передаёт `startapp` мини-приложению. */
export const MAX_START_PARAM = 'WebAppStartParam';

/** Payload'ы мини-приложения — короткий список для постов и Кузьмича. */
export const MAP_START_PAYLOADS = {
  overview: 'map',
  safety: 'map-safety',
  place: (ref: string) => `place-${ref}`,
  volcano: (ref: string) => `volcano-${ref}`,
} as const;

function placeRef(raw: string): string | null {
  return PLACE_REF_RE.test(raw) ? raw : null;
}

/** Цель по payload мини-приложения. Незнакомое или битое — null. */
export function mapTargetFromStartParam(payload: string | null | undefined): MapTarget | null {
  if (typeof payload !== 'string' || !START_PARAM_RE.test(payload)) return null;
  if (payload === MAP_START_PAYLOADS.overview) return { kind: 'overview' };
  if (payload === MAP_START_PAYLOADS.safety) return { kind: 'safety' };
  const m = /^(?:place|volcano)-(.+)$/.exec(payload);
  const ref = m ? placeRef(m[1]) : null;
  return ref ? { kind: 'place', ref } : null;
}

type Search = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | null =>
  (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * Цель по параметрам адреса `/map`. Порядок: `place`, затем payload MAX, затем
 * `show=safety`; ничего из этого — обзор края.
 */
export function mapTargetFromSearch(params: Search): MapTarget {
  const place = first(params.place);
  const ref = place ? placeRef(place) : null;
  if (ref) return { kind: 'place', ref };
  const fromMax = mapTargetFromStartParam(first(params[MAX_START_PARAM]));
  if (fromMax) return fromMax;
  if (first(params.show) === 'safety') return { kind: 'safety' };
  return { kind: 'overview' };
}

/** Ссылка сайта на карту с местом. Битая ссылка на место — обзор карты. */
export function mapPlaceHref(ref: string): string {
  return placeRef(ref) ? `/map?place=${ref}` : '/map';
}

export const MAP_SAFETY_HREF = '/map?show=safety';

/** Ссылка, открывающая мини-приложение бота MAX с payload. Битое — null. */
export function maxStartAppLink(bot: string, payload: string): string | null {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(bot) || !START_PARAM_RE.test(payload)) return null;
  return `https://max.ru/${bot}?startapp=${payload}`;
}
