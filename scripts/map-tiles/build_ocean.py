#!/usr/bin/env python3
"""
Океан для обзорного яруса — из полигонов суши OpenStreetMap.

── Зачем ──────────────────────────────────────────────────────────────────

Обзор (z4-7) красит море по высоте: Copernicus DEM держит над водой ноль,
и первая ступень гипсометрии рисует его цветом воды. Это работает, пока у
DEM есть данные. Там, где их нет — дыры покрытия у северных клеток, кромка
мозаики, — обзор до 04.09 красил дыру ТЕМ ЖЕ цветом, что море, а после
починки красит «не знаю»-серым. Серый честнее, но человек на обзоре видит
пятна серого посреди Охотского моря и не понимает, суша это или нет.

Ответ — не угадывать по высоте, а спросить того, кто знает берег: OSM.
Полигоны суши (osmdata.openstreetmap.de, из natural=coastline) — источник
границы «земля/вода» для любой OSM-карты. Океан = bbox обзора минус суша.
Слой ложится ПОВЕРХ гипсометрии: море становится морем и там, где DEM
молчит, а дыры на суше остаются серыми — они и есть неизвестность.

── Почему упрощённый набор и почему не Natural Earth ─────────────────────

Полный набор полигонов суши — ~700 МБ на весь мир; упрощённый
(simplified-land-polygons-complete-3857) — ~30 МБ, и его точности хватает
на z7 с запасом: пиксель z7 на широте 56° — ~680 м. Natural Earth 10m
(уже есть в scripts/build-kamchatka-coastline.py) грубее — 1-2 км, на
z7 берег плыл бы на два-три пикселя. Для клеток (z8-13) этот слой НЕ
нужен: там DEM читается на полной сетке, и ноль высоты — честное море.

── Честность ──────────────────────────────────────────────────────────────

Пустой океан — не ответ. Если в bbox не пересёкся ни один полигон суши
или суша занимает подозрительную долю (меньше 5 % или больше 95 % bbox),
скрипт выходит с ошибкой: значит, скачан не тот набор или проекция не та,
и заливать такой файл нельзя — карта покрасила бы Камчатку водой.

── Рамка — по границам тайлов z4, не по bbox края ──────────────────────────

Кадр z4 (снимки 05.09, прогон 7): океан кончался ровно на bbox края
(155-175 / 51-65), а тайлы обзора z4 шире — 135-180 по долготе и
41-66.5 по широте. За рамкой сквозь дыру показывалась гипсометрия: серый
«нет данных» там, где у DEM нет тайлов, и синий ноль там, где есть, —
полосами. Поэтому рамка расширяется до границ тайлов z4, накрывающих bbox
(--tile-zoom 4): суша за рамкой края тоже вычитается — полигоны суши OSM
на весь мир, — и море остаётся морем до края тайла.

    python3 scripts/map-tiles/build_ocean.py \
        --bbox 155,51,175,65 --out .cache/packs/krai-overview.ocean.geojson
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request
import zipfile


def tile_frame(west: float, south: float, east: float, north: float, z: int) -> tuple[float, float, float, float]:
    """Границы тайлов Web Mercator зума z, накрывающих bbox (west, south, east, north)."""
    n = 2 ** z

    def lon_to_x(lon: float) -> float:
        return (lon + 180.0) / 360.0 * n

    def lat_to_y(lat: float) -> float:
        r = math.radians(lat)
        return (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n

    def x_to_lon(x: float) -> float:
        return x / n * 360.0 - 180.0

    def y_to_lat(y: float) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))

    x0, x1 = math.floor(lon_to_x(west)), math.ceil(lon_to_x(east))
    y0, y1 = math.floor(lat_to_y(north)), math.ceil(lat_to_y(south))
    return x_to_lon(x0), y_to_lat(y1), x_to_lon(x1), y_to_lat(y0)

SOURCE_URL = 'https://osmdata.openstreetmap.de/download/simplified-land-polygons-complete-3857.zip'
ATTRIBUTION = '© OpenStreetMap contributors'
# Допуск упрощения, градусы: ~200 м — втрое мельче пикселя z7.
SIMPLIFY_DEG = 0.002


def download(url: str, dest: str) -> None:
    if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000:
        print(f'архив уже скачан: {dest} ({os.path.getsize(dest) / 1e6:.1f} МБ)')
        return
    os.makedirs(os.path.dirname(dest) or '.', exist_ok=True)
    started = time.time()
    with urllib.request.urlopen(url, timeout=120) as r, open(dest, 'wb') as f:
        total = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
    print(f'скачано {total / 1e6:.1f} МБ за {time.time() - started:.0f} с: {url}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='west,south,east,north (WGS84)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--source-url', default=SOURCE_URL)
    ap.add_argument('--cache-dir', default='.cache/land-polygons')
    ap.add_argument('--tile-zoom', type=int, default=4,
                    help='расширить рамку до границ тайлов этого зума (0 — не расширять)')
    args = ap.parse_args()

    try:
        import shapefile  # pyshp
        from pyproj import Transformer
        from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape
        from shapely.geometry.polygon import orient
        from shapely.ops import transform, unary_union
    except ImportError as e:
        print(f'нет зависимости: {e}. Нужны pyshp, pyproj, shapely.', file=sys.stderr)
        return 2

    west, south, east, north = (float(x) for x in args.bbox.split(','))
    if args.tile_zoom > 0:
        fw, fs, fe, fn = tile_frame(west, south, east, north, args.tile_zoom)
        print(f'рамка по тайлам z{args.tile_zoom}: {fw:.3f},{fs:.3f},{fe:.3f},{fn:.3f} (bbox края {west},{south},{east},{north})')
        west, south, east, north = fw, fs, fe, fn
    started = time.time()

    archive = os.path.join(args.cache_dir, 'simplified-land-polygons-complete-3857.zip')
    try:
        download(args.source_url, archive)
    except Exception as e:  # noqa: BLE001 — любой отказ сети — отказ сборки, не пустой океан
        print(f'ОТКАЗ: полигоны суши не скачались: {e}', file=sys.stderr)
        return 1
    with zipfile.ZipFile(archive) as z:
        z.extractall(args.cache_dir)
    shp = None
    for root, _dirs, files in os.walk(args.cache_dir):
        for name in files:
            if name.endswith('.shp'):
                shp = os.path.join(root, name)
    if not shp:
        print('ОТКАЗ: в архиве нет .shp', file=sys.stderr)
        return 1

    # Фильтр по bbox — в проекции набора (3857), чтобы не перепроецировать
    # десятки тысяч полигонов мира ради нескольких сотен камчатских.
    to_3857 = Transformer.from_crs('EPSG:4326', 'EPSG:3857', always_xy=True)
    to_4326 = Transformer.from_crs('EPSG:3857', 'EPSG:4326', always_xy=True)
    mx0, my0 = to_3857.transform(west, south)
    mx1, my1 = to_3857.transform(east, north)
    frame_4326 = box(west, south, east, north)

    reader = shapefile.Reader(shp)
    total_polys = len(reader)
    land_parts = []
    for sh in reader.iterShapes():
        bx0, by0, bx1, by1 = sh.bbox
        if bx1 < mx0 or bx0 > mx1 or by1 < my0 or by0 > my1:
            continue
        g = shape(sh.__geo_interface__)
        if g.is_empty:
            continue
        g = transform(to_4326.transform, g)
        g = g.intersection(frame_4326)
        if not g.is_empty:
            land_parts.append(g)
    print(f'полигонов суши в наборе: {total_polys}, в bbox: {len(land_parts)}')
    if not land_parts:
        print('ОТКАЗ: ни один полигон суши не пересёк bbox — не тот набор или не та проекция.', file=sys.stderr)
        return 1

    land = unary_union(land_parts)
    frame_area = frame_4326.area
    land_share = land.area / frame_area
    print(f'доля суши в bbox: {land_share * 100:.1f} %')
    if land_share < 0.05 or land_share > 0.95:
        print('ОТКАЗ: доля суши неправдоподобна для края с морем по трём сторонам.', file=sys.stderr)
        return 1

    ocean = frame_4326.difference(land).simplify(SIMPLIFY_DEG, preserve_topology=True)
    if ocean.is_empty:
        print('ОТКАЗ: океан пуст после вычитания.', file=sys.stderr)
        return 1
    # Ориентация колец — RFC 7946: внешнее против часовой, дыры по часовой.
    # GEOS отдаёт наоборот, а MapLibre судит «внешнее или дыра» по ЗНАКУ
    # площади кольца, не по порядку. Прогон 1 (05.09) залил океан без этого
    # шага, и на телефоне владельца синей оказалась суша: кольца-дыры стали
    # фигурами, рамка выпала. Проверяется ниже, а не предполагается.
    parts = list(ocean.geoms) if isinstance(ocean, MultiPolygon) else [ocean]
    parts = [orient(pg, 1.0) for pg in parts if isinstance(pg, Polygon) and not pg.is_empty]
    for pg in parts:
        if not pg.exterior.is_ccw or any(r.is_ccw for r in pg.interiors):
            print('ОТКАЗ: ориентация колец не RFC 7946 после orient().', file=sys.stderr)
            return 1
    holes = sum(len(pg.interiors) for pg in parts)
    print(f'частей океана: {len(parts)}, дыр (островов суши внутри): {holes}, кольца ориентированы по RFC 7946')
    ocean = MultiPolygon(parts) if len(parts) > 1 else parts[0]
    geom = mapping(ocean)
    vertices = sum(len(ring) for poly in (geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]) for ring in poly)

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    fc = {
        'type': 'FeatureCollection',
        'attribution': ATTRIBUTION,
        'source': args.source_url,
        'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'bbox': [west, south, east, north],
        'features': [{
            'type': 'Feature',
            'properties': {'kind': 'ocean', 'land_share': round(land_share, 4)},
            'geometry': geom,
        }],
    }
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(args.out)
    print(f'океан: {vertices} вершин, {size / 1024:.0f} КБ -> {args.out}')
    print(f'время сборки: {time.time() - started:.0f} с')
    return 0


if __name__ == '__main__':
    sys.exit(main())
