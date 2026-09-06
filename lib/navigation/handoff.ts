/**
 * lib/navigation/handoff.ts
 *
 * Передача маршрута в настоящий навигатор.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Слово владельца 11.08: «смысл людям пользоваться нашей кривой, если есть
 * другие». Возражать нечем. Organic Maps, Яндекс.Карты и 2ГИС строят дорогу
 * годами и делают это лучше нас; наш роутер на пробе того же вечера отвечал
 * «пути нет» на четыре километра по Петропавловску.
 *
 * Значит дорога — не наша задача. Наше — тропа за концом дороги и
 * безопасность на ней: чего ждать от места, надо ли регистрироваться в МЧС,
 * что говорит вердикт, куда жать при беде. Ни один навигатор этого не знает.
 * А довезти до начала тропы пусть везёт тот, кто умеет, — в один тап.
 *
 * ── Порядок координат ──────────────────────────────────────────────────────
 *
 * У провайдеров он РАЗНЫЙ: Яндекс и Organic Maps ждут `lat,lng`, 2ГИС —
 * `lng,lat`. Перепутать значит увезти человека в другое полушарие, и это
 * та же семья ошибок, что «0 вместо неизвестно»: ссылка откроется, выглядеть
 * будет рабочей и будет врать. Поэтому порядок закреплён тестами
 * (tests/unit/navigation-handoff.test.ts) на камчатских координатах, где
 * подмена сразу видна: 53,158 против 158,53 — Камчатка против пустого места.
 *
 * ── Откуда строим ──────────────────────────────────────────────────────────
 *
 * Маршрут строится, только когда известна точка старта. Формы «origin
 * пустой, возьми моё местоположение» у провайдеров разные и недокументированы
 * до конца — придумывать их значит наугад собрать ссылку, которая иногда
 * открывает не то. Без фикса GPS отдаём честную ссылку НА ТОЧКУ: навигатор
 * её покажет, и человек сам скажет «маршрут отсюда».
 */

export type NavApp = 'organic' | 'maps_me' | 'yandex' | 'dgis';
export type NavMode = 'car' | 'foot';

export interface NavPoint {
  lat: number;
  lng: number;
  name?: string;
}

export interface NavLink {
  app: NavApp;
  /** Имя приложения — для aria-label и подсказки. */
  label: string;
  /** Марка приложения на кнопке. */
  icon: string;
  url: string;
  /** Ссылка ведёт маршрут, а не просто показывает точку. */
  isRoute: boolean;
}

export const NAV_LABELS: Record<NavApp, string> = {
  organic: 'Organic Maps',
  maps_me: 'MAPS.ME',
  yandex: 'Яндекс.Карты',
  dgis: '2ГИС',
};

/**
 * Марка приложения на кнопке (владелец 06.09: «уменьшить внешние карты,
 * просто логотипом на кнопке»). Слово состояния — «Маршрут в …» /
 * «Показать в …» — с кнопки уходит в подпись ряда и в aria-label, не
 * теряется. Файлы — public/images/nav, цвета марок — фирменные, поэтому
 * они в SVG, а не в коде.
 */
export const NAV_ICONS: Record<NavApp, string> = {
  organic: '/images/nav/organic-maps.svg',
  maps_me: '/images/nav/maps-me.svg',
  yandex: '/images/nav/yandex-maps.svg',
  dgis: '/images/nav/2gis.svg',
};

/** Координата пригодна для ссылки: число, в пределах Земли, не ноль-ноль. */
function usable(p: NavPoint | null | undefined): p is NavPoint {
  if (!p) return false;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
  if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return false;
  // 0,0 — Гвинейский залив: так выглядит потерянная координата, а не место
  return !(p.lat === 0 && p.lng === 0);
}

/** Шесть знаков — около 10 см, дальше только шум. */
function c(v: number): string {
  return v.toFixed(6);
}

function title(p: NavPoint, fallback: string): string {
  const n = p.name?.trim();
  return n && n !== '' ? n : fallback;
}

/**
 * Ссылка «показать точку» — работает всегда, старт не нужен.
 */
export function pointUrl(app: NavApp, to: NavPoint): string | null {
  if (!usable(to)) return null;
  switch (app) {
    case 'organic':
      return `om://map?v=1&ll=${c(to.lat)},${c(to.lng)}&n=${encodeURIComponent(title(to, 'Точка'))}`;
    case 'maps_me':
      // Универсальная HTTPS-ссылка, не нативная схема (та у MAPS.ME —
      // `mapsme://`, отдельная от om:// Organic Maps) — сверено с офиц. вики
      // MAPS.ME: github.com/mapsme/api-android/wiki/Deeplinks. Параметры
      // v/ll/n совпадают с Organic Maps (общее происхождение формата), но
      // https-ссылка надёжнее: работает и без спец. обработки intent на ОС,
      // и как веб-фолбэк, если приложение не установлено.
      return `https://dlink.maps.me/map?v=1&ll=${c(to.lat)},${c(to.lng)}&n=${encodeURIComponent(title(to, 'Точка'))}`;
    case 'yandex':
      // pt — точка, порядок lng,lat; ll — центр карты, тоже lng,lat
      return `https://yandex.ru/maps/?pt=${c(to.lng)},${c(to.lat)}&z=15&l=map`;
    case 'dgis':
      // 2ГИС: firm/geo по координатам — порядок lng,lat
      return `https://2gis.ru/geo/${c(to.lng)},${c(to.lat)}`;
  }
}

/**
 * Ссылка «построить маршрут». `null`, если старт неизвестен или координаты
 * негодные — тогда вызывающий берёт `pointUrl`.
 */
export function routeUrl(
  app: NavApp, from: NavPoint | null | undefined, to: NavPoint, mode: NavMode,
): string | null {
  if (!usable(from) || !usable(to)) return null;

  switch (app) {
    case 'organic': {
      // Схема и значения type сверены с исходниками Organic Maps, не по памяти:
      //   форма — iphone/Maps/Tests/.../GeoNavigationToOMURLConverterTests.swift
      //     "om://route?sll=<a>&saddr=&dll=<b>&daddr=&type=<router>"
      //   значения — libs/routing/router.cpp, ToString/FromString(RouterType):
      //     "vehicle" | "pedestrian" | "bicycle" | "transit" | "ruler"
      //   (FromString сравнивает строго, поэтому строчные буквы обязательны)
      const type = mode === 'car' ? 'vehicle' : 'pedestrian';
      return `om://route?sll=${c(from.lat)},${c(from.lng)}`
        + `&saddr=${encodeURIComponent(title(from, 'Я'))}`
        + `&dll=${c(to.lat)},${c(to.lng)}`
        + `&daddr=${encodeURIComponent(title(to, 'Точка'))}`
        + `&type=${type}`;
    }
    case 'maps_me': {
      // Та же форма параметров, что у Organic Maps (sll/saddr/dll/daddr/type,
      // те же значения type: vehicle/pedestrian/bicycle) — сверено с офиц.
      // вики MAPS.ME (см. pointUrl выше), не по памяти и не по аналогии.
      const type = mode === 'car' ? 'vehicle' : 'pedestrian';
      return `https://dlink.maps.me/route?sll=${c(from.lat)},${c(from.lng)}`
        + `&saddr=${encodeURIComponent(title(from, 'Я'))}`
        + `&dll=${c(to.lat)},${c(to.lng)}`
        + `&daddr=${encodeURIComponent(title(to, 'Точка'))}`
        + `&type=${type}`;
    }
    case 'yandex': {
      // rtext=откуда~куда, каждая точка lat,lng; rtt=auto|pd
      const rtt = mode === 'car' ? 'auto' : 'pd';
      const rtext = `${c(from.lat)},${c(from.lng)}~${c(to.lat)},${c(to.lng)}`;
      return `https://yandex.ru/maps/?rtext=${encodeURIComponent(rtext)}&rtt=${rtt}`;
    }
    case 'dgis': {
      // 2ГИС: /directions/tab/<car|pedestrian>/points/|lng,lat|lng,lat
      const tab = mode === 'car' ? 'car' : 'pedestrian';
      const pts = `|${c(from.lng)},${c(from.lat)}|${c(to.lng)},${c(to.lat)}`;
      return `https://2gis.ru/directions/tab/${tab}/points/${encodeURIComponent(pts)}`;
    }
  }
}

/**
 * Готовый набор кнопок для экрана.
 *
 * Порядок не случаен: Organic Maps первым, потому что он один из четырёх
 * работает без сети — а на Камчатке связь кончается раньше дороги. MAPS.ME —
 * сразу за ним: то же происхождение deep-link формата (см. pointUrl), и
 * многие туристы уже держат именно это приложение, а не Organic Maps.
 * Маршрутные ссылки идут вперёд точечных: если старт известен, человеку
 * нужен маршрут, а не булавка.
 */
export function navLinks(
  from: NavPoint | null | undefined, to: NavPoint, mode: NavMode = 'car',
): NavLink[] {
  const apps: NavApp[] = ['organic', 'maps_me', 'yandex', 'dgis'];
  const out: NavLink[] = [];
  for (const app of apps) {
    const route = routeUrl(app, from, to, mode);
    if (route) {
      out.push({ app, label: NAV_LABELS[app], icon: NAV_ICONS[app], url: route, isRoute: true });
      continue;
    }
    const point = pointUrl(app, to);
    if (point) out.push({ app, label: NAV_LABELS[app], icon: NAV_ICONS[app], url: point, isRoute: false });
  }
  return out;
}
