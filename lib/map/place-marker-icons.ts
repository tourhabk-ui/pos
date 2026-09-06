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
 */

const ICONS_BY_KIND: Record<string, (hex: string) => string> = {
  volcano: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 2L2 22h20L12 2z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="2" fill="#fff" opacity="0.8"/></svg>`,
  hot_spring: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M9 14c0-2 1.5-3 3-3s3 1 3 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  geyser: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M12 8v6M9 11l3 3 3-3" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lake: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M7 14c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  mountain: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L3 22h18L12 4z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M8 22l4-8 4 8" stroke="#fff" stroke-width="1" stroke-linecap="round"/></svg>`,
  waterfall: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M10 10v8M14 10v8" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  beach: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.6"/></svg>`,
  viewpoint: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M12 10v4l3 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rock: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M7 20l2-12 6-4 4 8-3 8H7z" fill="${hex}" stroke="#fff" stroke-width="1.5"/></svg>`,
  island: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><ellipse cx="12" cy="18" rx="8" ry="4" fill="#475569" opacity="0.3"/><path d="M4 18c0-4 3-8 8-8s8 4 8 8-3.5 6-8 6-8-2-8-6z" fill="${hex}" stroke="#fff" stroke-width="1.5"/></svg>`,
  forest: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 4L6 16h12L12 4z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><rect x="11" y="16" width="2" height="6" rx="1" fill="#fff" opacity="0.6"/></svg>`,
  river: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M8 14c2 0 2-3 4-3s2 3 4 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  bay: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M7 14c1.5-1.5 3-1.5 5 0s3.5 1.5 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M7 18c1.5-1 3-1 5 0s3.5 1 5 0" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/></svg>`,
  museum: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M3 14l9-8 9 8v6H3v-6z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><rect x="7" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="11" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/><rect x="15" y="16" width="2" height="4" rx="0.5" fill="#fff" opacity="0.6"/></svg>`,
  historical: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M12 8v4l2 2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // Долина, мыс, пещера и посёлок — подписаны своим словом в LOCATION_LABELS
  // (components/map/PlaceMapSheet.tsx) и LOCATION_TYPE_CONFIG
  // (app/map/_MapPageClient.tsx), но до этой правки падали на общую форму
  // «other» — подпись называла одно, значок показывал другое.
  valley: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M8 11l4 6 4-6" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cave: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><path d="M7 18a5 6 0 0 1 10 0" fill="#1A1714" opacity="0.55"/></svg>`,
  cape: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><ellipse cx="12" cy="18" rx="8" ry="4" fill="#475569" opacity="0.3"/><path d="M5 16h7l4 8H5z" fill="${hex}" stroke="#fff" stroke-width="1.5"/></svg>`,
  settlement: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><path d="M12 3L3 12v13h18V12L12 3z" fill="${hex}" stroke="#fff" stroke-width="1.5"/><rect x="9.5" y="17" width="5" height="8" rx="0.5" fill="#fff" opacity="0.6"/></svg>`,
  other: (hex) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28" fill="none"><circle cx="12" cy="14" r="10" fill="${hex}" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#fff" opacity="0.5"/></svg>`,
};

/** Виды мест, для которых есть своя форма — остальные падают на `other`. */
export const PLACE_MARKER_KINDS = Object.keys(ICONS_BY_KIND);

/** SVG-разметка маркера места данного типа, залитая указанным цветом. */
export function placeMarkerSvg(hex: string, kind: string | null | undefined): string {
  const make = (kind && ICONS_BY_KIND[kind]) || ICONS_BY_KIND.other;
  return make(hex);
}

/** Размер маркера в CSS-пикселях — общий для Leaflet divIcon и растра VedarMap. */
export const PLACE_MARKER_SIZE = { width: 24, height: 28 } as const;
