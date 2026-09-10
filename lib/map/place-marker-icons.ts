/**
 * lib/map/place-marker-icons.ts
 *
 * Форма маркера места — по типу локации, не общий кружок.
 *
 * Владелец 07.09, после переезда `/map` на VedarMap: «геоточки были все со
 * своими маркерами» — на старой Leaflet-карте вулкан рисовался силуэтом
 * горы, источник — кружком с волной пара, гейзер — фонтаном, и так у
 * каждого типа своя форма; у новой карты все места были одним кружком двух
 * цветов (тревога/ориентир). Разница читается с первого взгляда и была
 * потеряна при переезде не по решению, а по недосмотру.
 *
 * Раньше формы жили только в LeafletMap.tsx (использовались Leaflet-маркерами
 * поля «На маршруте»). Теперь это общий источник для обеих карт — VedarMap
 * растеризует те же SVG в спрайт (см. lib/map/place-icon-raster.ts), чтобы
 * форма не разъезжалась между картами так же, как чуть не разъехался вид
 * линии до §12.
 *
 * Кромка (`halo`, второй параметр) — фон карты, не всегда белый (владелец
 * 07.09: «цвета геоточек не отличаются от цветов высот»). Заливка маркера
 * (`peak`/`cliff`, lib/map/vedar-style.ts) — тёплый акцент из той же
 * земляной гаммы, что и гипсометрия склонов на VedarMap: на вулкане цвет
 * значка и цвет высоты под ним совпадают по семейству оттенков, и точка
 * растворяется в рельефе. Кромка была захардкожена в `#fff`, а он и сам
 * теряется на светлой теме (снег/сан #F4F4F4, песок) — то же слияние на
 * другом фоне. Кольцо цвета ФОНА КАРТЫ (`p.background`) контрастно любой
 * ступени рельефа по построению (гипсометрия его не красит) — тот же приём,
 * что уже стоит на `circle-stroke-color: p.background` у вершин, посёлков,
 * источников и перевалов в vedar-style.ts. LeafletMap не рисует гипсометрию
 * и рельеф под маркером не гуляет — там кромка остаётся белой (значение по
 * умолчанию, вызов не меняется).
 */

const ICONS_BY_KIND: Record<string, (hex: string, halo: string) => string> = {
  volcano: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 2L2 22h20L12 2z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><circle cx="12" cy="14" r="2" fill="#fff" opacity="0.8"/></svg>`,
  hot_spring: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M9 14c0-2 1.5-3 3-3s3 1 3 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  geyser: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M12 8v6M9 11l3 3 3-3" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lake: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M7 14c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  mountain: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L3 22h18L12 4z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M8 22l4-8 4 8" stroke="#fff" stroke-width="1" stroke-linecap="round"/></svg>`,
  waterfall: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M10 10v8M14 10v8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  beach: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.6"/></svg>`,
  viewpoint: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M12 10v4l3 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rock: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M7 20l2-12 6-4 4 8-3 8H7z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/></svg>`,
  island: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><ellipse cx="12" cy="18" rx="8" ry="4" fill="#475569" opacity="0.3"/><path d="M4 18c0-4 3-8 8-8s8 4 8 8-3.5 6-8 6-8-2-8-6z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/></svg>`,
  forest: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L6 16h12L12 4z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><rect x="11" y="16" width="2" height="6" rx="1" fill="#fff" opacity="0.6"/></svg>`,
  river: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M8 14c2 0 2-3 4-3s2 3 4 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  bay: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M7 14c1.5-1.5 3-1.5 5 0s3.5 1.5 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M7 18c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/></svg>`,
  museum: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M3 14l9-8 9 8v6H3v-6z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><rect x="7" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="11" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="15" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/></svg>`,
  historical: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M12 8v4l2 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // Долина, мыс, пещера и посёлок — подписаны своим словом в LOCATION_LABELS
  // (components/map/PlaceMapSheet.tsx) и LOCATION_TYPE_CONFIG
  // (app/map/_MapPageClient.tsx), но до этой правки падали на общую форму
  // «other» — подпись называла одно, значок показывал другое.
  valley: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M8 11l4 6 4-6" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cave: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><path d="M7 18a5 6 0 0 1 10 0" fill="#1A1714" opacity="0.55"/></svg>`,
  cape: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><ellipse cx="12" cy="18" rx="8" ry="4" fill="#475569" opacity="0.3"/><path d="M5 16h7l4 8H5z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/></svg>`,
  settlement: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 3L3 12v13h18V12L12 3z" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><rect x="9.5" y="17" width="5" height="8" rx="0.5" fill="#fff" opacity="0.6"/></svg>`,
  other: (hex, halo) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="${halo}" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.5"/></svg>`,
};

/** Виды мест, для которых есть своя форма — остальные падают на `other`. */
export const PLACE_MARKER_KINDS = Object.keys(ICONS_BY_KIND);

/**
 * SVG-разметка маркера места данного типа, залитая указанным цветом.
 *
 * `halo` — цвет кромки вокруг фигуры (по умолчанию белый, как было всегда
 * для LeafletMap). VedarMap передаёт `p.background` темы: под гипсометрией
 * заливка маркера и цвет высоты могут совпасть по гамме, и кромка обязана
 * быть цветом, которого гипсометрия не красит вовсе — иначе точка сливается
 * с рельефом под ней (см. шапку файла).
 */
export function placeMarkerSvg(hex: string, kind: string | null | undefined, halo: string = '#fff'): string {
  const make = (kind && ICONS_BY_KIND[kind]) || ICONS_BY_KIND.other;
  return make(hex, halo);
}

/** Размер маркера в CSS-пикселях — общий для Leaflet divIcon и растра VedarMap. */
export const PLACE_MARKER_SIZE = { width: 24, height: 28 } as const;

/**
 * Цвет заливки маркера — по КАТЕГОРИИ места, а не по опасности (владелец
 * 10.09: «разделять цветами места по фильтрам», опасность — контуром).
 *
 * До этой правки заливка на двух картах решалась по-разному: LeafletMap
 * красил по типу места (свой `COLOR_MAP` по имени цвета), а VedarMap — по
 * наличию `hazard_types` (два цвета на все ~20 типов: тревога/ориентир).
 * Разница читалась на старой карте и терялась на новой — тот же класс
 * разъезда, что уже чинили для форм (см. шапку файла, решение 07.09).
 *
 * Единый источник — здесь. LeafletMap получает готовый hex через
 * `marker.color` (собирается в app/map/_MapPageClient.tsx), VedarMap берёт
 * его же в `styleimagemissing`. Опасность (`hazard_types` не пуст) теперь
 * красит только КРОМКУ (halo), не заливку: иначе вулкан с записанным
 * профилем безопасности терял бы свой «вулканический» оранжевый и
 * становился неотличим от источника или обрыва.
 *
 * 15 основных категорий фильтра /map получают РАЗНЫЕ цвета — иначе
 * «разделять цветами» не читается глазом. Второстепенные виды (валяются
 * только в подписи карточки места — cape/settlement/museum/historical/
 * valley/cave) могут разделять цвет с основными: они не показываются рядом
 * в одном списке фильтров.
 */
export const PLACE_KIND_COLOR: Record<string, string> = {
  volcano:    '#D44A0C', // accent
  hot_spring: '#DC2626', // danger — тепло/ожог
  bay:        '#0891B2',
  lake:       '#38BDF8',
  mountain:   '#1E40AF',
  river:      '#0D9488',
  geyser:     '#06B6D4',
  waterfall:  '#2568B0', // ocean
  viewpoint:  '#8B5CF6',
  rock:       '#92400E',
  island:     '#3FB950',
  beach:      '#C2410C',
  forest:     '#15803D',
  museum:     '#6B7280',
  historical: '#A16207',
  cape:       '#6B7280',
  settlement: '#6B7280',
  valley:     '#0D9488',
  cave:       '#57534E',
  other:      '#6B7280',
};
