/**
 * Регионы Камчатки для офлайн-скачивания.
 * Координаты bbox — приближённые, уточняются по мере сбора геоданных.
 */

import { gridCellById, type GridCellId } from '@/lib/geo/grid-cells';

export type RegionId =
  | 'avacha-group'       // Авачинский, Корякский, Козельский
  | 'mutnovsky-gorely'   // Мутновский, Горелый, Опала
  | 'nalychevo'          // Налычево парк
  | 'klyuchevskoy'       // Ключевская группа, Толбачик
  | 'south-kamchatka'    // Курильское озеро, Ходутка
  | 'paratunka'          // Паратунка, Малки, термы юг
  | 'esso-bystrinsky'    // Эссо, Быстринский парк, центр
  | 'kronotsky'          // Кроноцкий заповедник, Долина гейзеров
  | 'commander-islands'  // Командорские острова
  | 'central-volcanoes'; // Жупановский, Карымский, Узон

export interface RegionBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Region {
  id: RegionId;
  name: string;
  shortDescription: string;
  bbox: RegionBbox;
  center: { lat: number; lng: number };
  defaultZoom: number;
  /** Приблизительный размер региона при скачивании (тайлы + данные), для отображения ДО скачивания */
  estimatedSizeRange: string;
  /** Приблизительное число маршрутов в регионе, для отображения ДО скачивания */
  estimatedRoutes: number;
}

export const REGIONS: Record<RegionId, Region> = {
  'avacha-group': {
    id: 'avacha-group',
    name: 'Авачинская группа',
    shortDescription: 'Авачинский, Корякский и Козельский вулканы — самый популярный треккинговый район рядом с Петропавловском.',
    bbox: { south: 52.8, west: 158.4, north: 53.6, east: 159.4 },
    center: { lat: 53.26, lng: 158.83 },
    defaultZoom: 10,
    estimatedSizeRange: '5-15 MB',
    estimatedRoutes: 41,
  },

  'mutnovsky-gorely': {
    id: 'mutnovsky-gorely',
    name: 'Мутновский и Горелый',
    shortDescription: 'Вулканы Мутновский (фумаролы, кратеры) и Горелый, Асача, Верхне-Опальские источники — юго-западный вулканический пояс.',
    // Запад 157.6 (03.09, было 157.8): Верхне-Опальские источники после
    // правки координаты (52.4417/157.7339, реестр ООПТ) оказались в зазоре
    // между Мутновским и Южной Камчаткой — своя карта у самих источников
    // показывала бы «вид вне всех районов реестра».
    bbox: { south: 52.2, west: 157.6, north: 53.1, east: 158.8 },
    center: { lat: 52.45, lng: 158.19 },
    defaultZoom: 10,
    estimatedSizeRange: '5-15 MB',
    estimatedRoutes: 85,
  },

  'nalychevo': {
    id: 'nalychevo',
    name: 'Налычево',
    shortDescription: 'Природный парк Налычево — горячие источники, вулканические ландшафты, маршруты от 2 до 7 дней.',
    bbox: { south: 53.1, west: 158.7, north: 53.9, east: 159.9 },
    center: { lat: 53.52, lng: 159.2 },
    defaultZoom: 10,
    estimatedSizeRange: '5-15 MB',
    estimatedRoutes: 95,
  },

  'klyuchevskoy': {
    id: 'klyuchevskoy',
    name: 'Ключевская группа',
    shortDescription: 'Ключевской — самый высокий действующий вулкан Евразии, Безымянный, Толбачик, Камень.',
    bbox: { south: 55.5, west: 159.8, north: 56.8, east: 161.5 },
    center: { lat: 56.07, lng: 160.64 },
    defaultZoom: 9,
    estimatedSizeRange: '10-25 MB',
    estimatedRoutes: 70,
  },

  'south-kamchatka': {
    id: 'south-kamchatka',
    name: 'Южная Камчатка',
    shortDescription: 'Курильское озеро с медведями, вулкан Ильинский, Ходутка — заповедный юг полуострова.',
    bbox: { south: 51.0, west: 156.8, north: 52.4, east: 158.5 },
    center: { lat: 51.5, lng: 157.4 },
    defaultZoom: 9,
    estimatedSizeRange: '10-30 MB',
    estimatedRoutes: 55,
  },

  'paratunka': {
    id: 'paratunka',
    name: 'Паратунка и Малки',
    shortDescription: 'Термальные курорты Паратунки, источники Малки — отдых после маршрутов, спа-зоны.',
    bbox: { south: 52.6, west: 157.8, north: 53.2, east: 158.6 },
    center: { lat: 52.9, lng: 158.17 },
    defaultZoom: 10,
    estimatedSizeRange: '3-10 MB',
    estimatedRoutes: 40,
  },

  'esso-bystrinsky': {
    id: 'esso-bystrinsky',
    name: 'Эссо и Быстринский парк',
    shortDescription: 'Посёлок Эссо, Быстринский природный парк — центральная Камчатка, маршруты к вулканам Ичинский, Хангар.',
    bbox: { south: 55.4, west: 157.5, north: 56.8, east: 159.5 },
    center: { lat: 55.93, lng: 158.7 },
    defaultZoom: 9,
    estimatedSizeRange: '15-40 MB',
    estimatedRoutes: 60,
  },

  'kronotsky': {
    id: 'kronotsky',
    name: 'Кроноцкий заповедник',
    shortDescription: 'Долина гейзеров, Кальдера Узона, Кроноцкое озеро — объект UNESCO, только вертолётный доступ.',
    bbox: { south: 53.8, west: 159.9, north: 55.0, east: 162.0 },
    center: { lat: 54.45, lng: 160.6 },
    defaultZoom: 9,
    estimatedSizeRange: '15-45 MB',
    estimatedRoutes: 45,
  },

  'commander-islands': {
    id: 'commander-islands',
    name: 'Командорские острова',
    shortDescription: 'Остров Беринга, котики, птичьи базары — отдалённый архипелаг в Беринговом море.',
    bbox: { south: 54.5, west: 165.5, north: 56.0, east: 167.5 },
    center: { lat: 55.2, lng: 166.3 },
    defaultZoom: 9,
    estimatedSizeRange: '10-25 MB',
    estimatedRoutes: 20,
  },

  'central-volcanoes': {
    id: 'central-volcanoes',
    name: 'Центральные вулканы',
    shortDescription: 'Жупановский, Карымский, Узон — активные вулканы Восточного хребта, специализированные экспедиции.',
    bbox: { south: 53.9, west: 159.0, north: 55.0, east: 160.8 },
    center: { lat: 54.05, lng: 159.44 },
    defaultZoom: 9,
    estimatedSizeRange: '10-30 MB',
    estimatedRoutes: 35,
  },
};

/** Список всех регионов как массив */
export const REGIONS_LIST: Region[] = Object.values(REGIONS);

/**
 * Район пакета карты: нарисованный район реестра ИЛИ градусная клетка сетки
 * (lib/geo/grid-cells.ts, «вся Камчатка», 03.09). Клетки — не районы для
 * человека (в списке офлайн-скачивания их нет), но пакет у них того же
 * устройства, и конвейер сборки, хранилище и карта различать их не должны.
 */
/**
 * Обзорный ярус — ОДИН пакет на весь край, зумы 4-7.
 *
 * Скрин владельца 04.09 07:42: человек смотрит на 119 км до цели, и карты
 * нет вовсе. Причина не в охвате: район и клетка начинаются с зума 8, а
 * ниже нижнего зума MapLibre растровый источник не рисует и вниз не
 * масштабирует. Сколько клеток ни собери, обзорный масштаб останется
 * пустым — дырка в замысле, а не в данных.
 *
 * Опустить нижний зум у всех пакетов было нельзя: 112 клеток потащили бы
 * каждая свою копию одних и тех же мелких тайлов, один и тот же кусок
 * Охотского моря лёг бы в хранилище сто раз. Поэтому ярус отдельный, и
 * зумы у ярусов НЕ ПЕРЕСЕКАЮТСЯ (обзор 4-7, пакеты с 8): на любом зуме
 * рельеф рисует ровно один из них, стыка не видно.
 *
 * Это не район для человека: в списке офлайн-скачивания его нет, точке он
 * не сопоставляется (regionsForPoint его не вернёт). Карта подкладывает
 * его сама, как соседа, — он пересекает любой вид края.
 */
export const OVERVIEW_ID = 'krai-overview' as const;
export type OverviewId = typeof OVERVIEW_ID;
/** Охват края: объединение bbox всех районов и клеток сетки (замер 04.09). */
export const OVERVIEW_BBOX: RegionBbox = { west: 155, south: 51, east: 175, north: 65 };

export type PackRegionId = RegionId | GridCellId | OverviewId;

export function isRegionId(id: string): id is RegionId {
  return Object.prototype.hasOwnProperty.call(REGIONS, id);
}

export function isOverviewId(id: string): id is OverviewId {
  return id === OVERVIEW_ID;
}

/** Границы района, клетки или обзора; null — такого id в реестре нет. */
export function packRegionBbox(id: string): RegionBbox | null {
  if (isRegionId(id)) return REGIONS[id].bbox;
  if (isOverviewId(id)) return OVERVIEW_BBOX;
  return gridCellById(id)?.bbox ?? null;
}

/** Центр района, клетки или обзора; null — такого id в реестре нет. */
export function packRegionCenter(id: string): { lat: number; lng: number } | null {
  if (isRegionId(id)) return REGIONS[id].center;
  if (isOverviewId(id)) {
    return {
      lat: (OVERVIEW_BBOX.south + OVERVIEW_BBOX.north) / 2,
      lng: (OVERVIEW_BBOX.west + OVERVIEW_BBOX.east) / 2,
    };
  }
  return gridCellById(id)?.center ?? null;
}

// getRoutesInBbox и getRegionForPoint убраны 22.08.2026 (перепись).
//
// Обе — чистые геометрические утилиты без потребителя. Карта фильтрует
// маршруты на сервере запросом, а не в памяти браузера; регион для точки
// нигде не спрашивают — офлайн-пакет человек выбирает сам, и это осознанно:
// угадать за него, какой район ему нужен, значит скачать не тот.
