/**
 * lib/geo/grid-cells.ts — сплошная сетка пакетов карты по всей суше края.
 *
 * Слово владельца 03.09: «нужно делать всю Камчатку». Десять нарисованных
 * районов реестра (lib/geo/regions.ts) покрывают около 12 кв.° и оставляют
 * зазоры даже между собой — Верхне-Опальские источники после правки
 * координаты легли ровно в такой зазор. Дорисовывать районы по одному —
 * значит вечно догонять очередной скрин «здесь пакета карты нет».
 *
 * Поэтому второй слой реестра — градусные клетки 1°×1°. Клетка входит в
 * сетку, если пересекает полигон Камчатского края (Natural Earth 10m,
 * admin-1, «Kamchatka Krai») хотя бы на 0.02 кв.°; доля суши записана у
 * каждой — по ней видно, где клетка почти вся море. Итого 112 клеток на
 * 72 кв.° края; полуостров (юг клетки до 60°) — 71 клетка, север
 * (Корякия) — остальные. Замер 03.09 по маске Natural Earth, не по Copernicus: у DEM
 * над морем клеток нет, и сборка сама скажет «НЕТ КЛЕТКИ», если что.
 *
 * Клетка — не «район» для человека: в списке офлайн-скачивания районов её
 * нет, имени у неё нет, на карте она подкладывается сама, когда попадает в
 * кадр (VedarMap, moveend), как и соседние районы. Нарисованные районы
 * остаются главными: точка внутри района берёт его пакет, клетку — только
 * если ни один район её не накрывает (field-base-map.regionsForPoint).
 *
 * Обещание «пакет клетки лежит в хранилище» — lib/map/pack-source.ts,
 * BUILT_GRID_CELLS: ставится после заливки, не до, как у районов.
 */

import type { RegionBbox } from '@/lib/geo/regions';

/** Идентификатор клетки: юго-западный угол в целых градусах. */
export type GridCellId = `cell-${number}n${number}e`;

export interface GridCell {
  id: GridCellId;
  bbox: RegionBbox;
  center: { lat: number; lng: number };
  /** Площадь пересечения с полигоном края, кв.° (Natural Earth 10m). */
  landDeg2: number;
}

export function gridCellId(lat: number, lng: number): GridCellId {
  return `cell-${lat}n${lng}e`;
}

function cell(lat: number, lng: number, landDeg2: number): GridCell {
  return {
    id: gridCellId(lat, lng),
    bbox: { south: lat, west: lng, north: lat + 1, east: lng + 1 },
    center: { lat: lat + 0.5, lng: lng + 0.5 },
    landDeg2,
  };
}

/** Все клетки края, с юга на север, с запада на восток. */
export const GRID_CELLS: readonly GridCell[] = [
  cell(51, 156, 0.437),
  cell(51, 157, 0.589),
  cell(51, 158, 0.041),
  cell(52, 156, 0.689),
  cell(52, 157, 1.0),
  cell(52, 158, 0.496),
  cell(53, 155, 0.024),
  cell(53, 156, 0.972),
  cell(53, 157, 1.0),
  cell(53, 158, 0.985),
  cell(53, 159, 0.741),
  cell(54, 155, 0.278),
  cell(54, 156, 1.0),
  cell(54, 157, 1.0),
  cell(54, 158, 1.0),
  cell(54, 159, 0.995),
  cell(54, 160, 0.601),
  cell(54, 161, 0.447),
  cell(54, 162, 0.026),
  cell(54, 166, 0.063),
  cell(54, 167, 0.033),
  cell(55, 155, 0.4),
  cell(55, 156, 1.0),
  cell(55, 157, 1.0),
  cell(55, 158, 1.0),
  cell(55, 159, 1.0),
  cell(55, 160, 1.0),
  cell(55, 161, 0.846),
  cell(55, 166, 0.08),
  cell(56, 155, 0.118),
  cell(56, 156, 0.927),
  cell(56, 157, 1.0),
  cell(56, 158, 1.0),
  cell(56, 159, 1.0),
  cell(56, 160, 1.0),
  cell(56, 161, 1.0),
  cell(56, 162, 0.735),
  cell(56, 163, 0.178),
  cell(57, 156, 0.12),
  cell(57, 157, 0.88),
  cell(57, 158, 0.998),
  cell(57, 159, 1.0),
  cell(57, 160, 1.0),
  cell(57, 161, 1.0),
  cell(57, 162, 0.792),
  cell(57, 163, 0.079),
  cell(58, 158, 0.181),
  cell(58, 159, 0.736),
  cell(58, 160, 1.0),
  cell(58, 161, 1.0),
  cell(58, 162, 0.343),
  cell(58, 163, 0.097),
  cell(58, 164, 0.117),
  cell(59, 159, 0.035),
  cell(59, 160, 0.478),
  cell(59, 161, 0.935),
  cell(59, 162, 0.991),
  cell(59, 163, 0.307),
  cell(59, 164, 0.149),
  cell(59, 166, 0.049),
  cell(60, 161, 0.086),
  cell(60, 162, 0.6),
  cell(60, 163, 0.853),
  cell(60, 164, 0.971),
  cell(60, 165, 0.792),
  cell(60, 166, 0.808),
  cell(60, 167, 0.555),
  cell(60, 168, 0.422),
  cell(60, 169, 0.569),
  cell(60, 170, 0.763),
  cell(60, 171, 0.279),
  cell(61, 162, 0.197),
  cell(61, 163, 0.182),
  cell(61, 164, 0.976),
  cell(61, 165, 1.0),
  cell(61, 166, 1.0),
  cell(61, 167, 1.0),
  cell(61, 168, 1.0),
  cell(61, 169, 1.0),
  cell(61, 170, 1.0),
  cell(61, 171, 1.0),
  cell(61, 172, 0.818),
  cell(61, 173, 0.406),
  cell(61, 174, 0.083),
  cell(62, 162, 0.428),
  cell(62, 163, 0.536),
  cell(62, 164, 0.723),
  cell(62, 165, 0.972),
  cell(62, 166, 1.0),
  cell(62, 167, 1.0),
  cell(62, 168, 0.99),
  cell(62, 169, 0.807),
  cell(62, 170, 0.321),
  cell(62, 171, 0.355),
  cell(62, 172, 0.413),
  cell(62, 173, 0.47),
  cell(62, 174, 0.058),
  cell(63, 162, 0.243),
  cell(63, 163, 1.0),
  cell(63, 164, 1.0),
  cell(63, 165, 1.0),
  cell(63, 166, 1.0),
  cell(63, 167, 1.0),
  cell(63, 168, 0.879),
  cell(63, 169, 0.223),
  cell(64, 162, 0.033),
  cell(64, 163, 0.71),
  cell(64, 164, 0.832),
  cell(64, 165, 0.743),
  cell(64, 166, 0.571),
  cell(64, 167, 0.459),
  cell(64, 168, 0.231),
];

const BY_ID: ReadonlyMap<string, GridCell> = new Map(GRID_CELLS.map(c => [c.id, c]));

export function isGridCellId(id: string): id is GridCellId {
  return BY_ID.has(id);
}

export function gridCellById(id: string): GridCell | null {
  return BY_ID.get(id) ?? null;
}

/** Клетки, накрывающие точку. Обычно одна; на целочисленной границе — до четырёх. */
export function gridCellsForPoint(lat: number, lng: number): GridCell[] {
  return GRID_CELLS.filter(c =>
    lat >= c.bbox.south && lat <= c.bbox.north && lng >= c.bbox.west && lng <= c.bbox.east);
}
