/**
 * Места страницы погоды (`/weather`) — один список для страницы, её адресов
 * и sitemap. Решение владельца 08.10: у погоды своя страница, а не строка в
 * сводке и ответе Кузьмича.
 *
 * Точка места берётся тем же путём, что у `get_weather` и сводки дня: имя
 * каталога — через `resolvePlaceCoords`, город и посёлки — из реестра
 * `lib/kuzmich/weather-tool`. Тогда «Авачинский» на странице и у Кузьмича —
 * одна и та же точка, и цифры не расходятся. Долины Налычево в каталоге как
 * точки нет; её координаты — зона погоды платформы (`zone-weather`), та же,
 * по которой Rescue судит о погоде маршрутов.
 *
 * Чего здесь нет намеренно: поиска по любому месту. Каждое имя — запрос к
 * Open-Meteo; открытый поиск отдал бы бесплатный лимит, который делят
 * Кузьмич, Rescue и планер, первому же обходчику страниц.
 */
import { DEFAULT_WEATHER_PLACE, WEATHER_SETTLEMENTS } from '@/lib/kuzmich/weather-tool';
import { ZONES } from '@/lib/services/safety/zone-weather';

export type WeatherPlaceGroup = 'city' | 'trail' | 'settlement';

export interface WeatherPlace {
  slug: string;
  /** Подпись на странице: «Авачинский вулкан». */
  name: string;
  /** Для заголовка и метаданных: «на Авачинском вулкане». */
  where: string;
  group: WeatherPlaceGroup;
  /**
   * Откуда точка. `catalog` — имя в каталоге мест, найденное тем же поиском,
   * что у `get_weather`; `point` — координаты из реестра платформы, `from` —
   * из какого. `point: null` — в реестре точки нет, страница так и скажет.
   */
  source: { catalog: string } | { point: { lat: number; lng: number } | null; from: string };
}

const settlement = (name: string): { point: { lat: number; lng: number } | null; from: string } => {
  const s = WEATHER_SETTLEMENTS.find((x) => x.name === name);
  // Посёлок пропал из реестра get_weather — точки нет, и страница скажет об
  // этом сама (исход «нет места»), а не упадёт при импорте. Сторож держит,
  // что все четыре на месте.
  return { point: s ? { lat: s.lat, lng: s.lng } : null, from: 'посёлки get_weather' };
};

export const DEFAULT_WEATHER_SLUG = 'petropavlovsk';

export const WEATHER_PLACES: readonly WeatherPlace[] = [
  {
    slug: DEFAULT_WEATHER_SLUG, name: 'Петропавловск-Камчатский', where: 'в Петропавловске-Камчатском', group: 'city',
    source: { point: { lat: DEFAULT_WEATHER_PLACE.lat, lng: DEFAULT_WEATHER_PLACE.lng }, from: 'центр города, get_weather' },
  },
  { slug: 'avachinsky', name: 'Авачинский вулкан', where: 'на Авачинском вулкане', group: 'trail', source: { catalog: 'Авачинский' } },
  { slug: 'mutnovsky', name: 'Мутновский вулкан', where: 'на Мутновском вулкане', group: 'trail', source: { catalog: 'Мутновский' } },
  {
    slug: 'nalychevo', name: 'Долина Налычево', where: 'в долине Налычево', group: 'trail',
    source: { point: { lat: ZONES.nalychevo.lat, lng: ZONES.nalychevo.lon }, from: 'зона погоды платформы' },
  },
  { slug: 'esso', name: 'Эссо', where: 'в Эссо', group: 'settlement', source: { catalog: 'Эссо' } },
  { slug: 'klyuchi', name: 'Ключи', where: 'в Ключах', group: 'settlement', source: settlement('Ключи') },
  { slug: 'ust-kamchatsk', name: 'Усть-Камчатск', where: 'в Усть-Камчатске', group: 'settlement', source: settlement('Усть-Камчатск') },
  { slug: 'sobolevo', name: 'Соболево', where: 'в Соболеве', group: 'settlement', source: settlement('Соболево') },
  { slug: 'palana', name: 'Палана', where: 'в Палане', group: 'settlement', source: settlement('Палана') },
];

export const WEATHER_GROUP_LABELS: Readonly<Record<WeatherPlaceGroup, string>> = {
  city: 'Город',
  trail: 'Вулканы и маршруты',
  settlement: 'Посёлки',
};

export function weatherPlaceBySlug(slug: string): WeatherPlace | null {
  return WEATHER_PLACES.find((p) => p.slug === slug) ?? null;
}

/** Адрес страницы места: у города — сама `/weather`, у остальных — `/weather/<slug>`. */
export function weatherPlaceHref(place: Pick<WeatherPlace, 'slug'>): string {
  return place.slug === DEFAULT_WEATHER_SLUG ? '/weather' : `/weather/${place.slug}`;
}
