#!/usr/bin/env python3
"""
Рельеф региона -> terrain-RGB в PMTiles. Своя подложка, свой офлайн.

── Зачем это существует ──────────────────────────────────────────────────

28.08 владелец отключил массовую закачку тайлов: публичная политика OSM
запрещает bulk download с tile.openstreetmap.org, и «Скачать регион» стало
честно отвечать отказом (public/sw.js, обработчик CACHE_TILES ->
TILES_UNAVAILABLE). В том же комментарии записано условие возврата:
«Вернётся, когда появится собственный источник (PMTiles)». Это он.

Источник высот — Copernicus GLO-30 (ESA), лежит на AWS Open Data без
регистрации и без ключа. Лицензия требует указания правообладателя: строка
атрибуции обязана быть на экране, она берётся из метаданных архива (см.
ATTRIBUTION ниже), а не пишется в вёрстке руками.

── GLO-90 -> GLO-30 (02.09, решение владельца «го») ─────────────────────

Первый живой рендер 02.09 (Авачинский перевал): «карта не очень качественно
прорисована». Причина не в стиле — в источнике: 90 м на отсчёт, и выше z12
детали НЕ СУЩЕСТВУЕТ. GLO-30 — тот же открытый набор ESA на том же AWS без
ключа, но 30 м: втрое плотнее по каждой оси. Меняются ровно три константы
(бакет, код разрешения в имени клетки, родной зум); всё остальное — те же
клетки 1°x1°, тот же COG, тот же конвейер. Клетка GLO-30 — 3600x3600
вместо 1200x1200 (~25 МБ против ~3), регион пробы — четыре клетки.

── Почему terrain-RGB, а не запечённый hillshade ─────────────────────────

Запечённая картинка рельефа несёт цвет внутри себя: под тёмный и светлый
стиль пришлось бы держать ДВА архива одних и тех же гор. terrain-RGB несёт
ВЫСОТЫ, а тень считает MapLibre на клиенте по правилам стиля — значит
палитра, направление света и контраст живут в токенах, и обе темы получаются
из одного пакета. Это прямое требование владельца к пробе: светлая и тёмная
палитра ценой одного файла, а не переделки.

── Предел зума назван по данным, а не по желанию ─────────────────────────

GLO-30 — это 30 метров на отсчёт (1 угловая секунда: ~31 м по широте,
~18.5 м по долготе на 53°). На широте Авачинской группы:

    z11 -> 45.8 м/пиксель
    z12 -> 22.9 м/пиксель   <- здесь данные ЗАКАНЧИВАЮТСЯ
    z13 -> 11.5 м/пиксель
    z14 ->  5.7 м/пиксель

Запечь z14 технически можно — интерполятор нарисует гладкие склоны с
точностью 5.7 м из данных с шагом 30 м. Это ровно тот дефект, из-за которого
мы отказались от генеративных моделей для карты (§4.0): выдуманный рельеф,
неотличимый по виду от измеренного, на экране, по которому человек идёт.

Поэтому: MAXZOOM = 13 — один уровень билинейного сглаживания сверх родного,
чтобы тень не рассыпалась ступенями, и ни одного уровня сверх того. (У
GLO-90 их было два, z10 -> z12; здесь один: z13 — уже 2.6 отсчёта на
пиксель, а каждый уровень вчетверо раздувает пакет.) Дальше MapLibre
растягивает сам (overzoom), и это видно как мягкость, а не как ложная
детализация. Метаданные архива несут `native_zoom` = 12, чтобы следующий
читатель не принял 13 за разрешение источника.

Использование:
    python3 scripts/map-tiles/build_terrain.py \
        --bbox 158.4,52.8,159.4,53.6 --out public/map-packs/avacha-group.terrain.pmtiles
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np

# Copernicus GLO-30 на AWS Open Data. Без ключа и без регистрации — в отличие
# от SRTM, который требует логина Earthdata (и потому в конвейер не взят).
DEM_BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com'
# Код разрешения в имени клетки — шаг сетки в ДЕСЯТЫХ угловой секунды:
# «COG_10» = 1" (GLO-30, ~30 м), «COG_30» = 3" (GLO-90, ~90 м). Из метров
# его не вывести — только из документации набора; менять вместе с бакетом.
DEM_RES_CODE = '10'
DEM_PRODUCT = 'Copernicus GLO-30 (ESA), AWS Open Data'
ATTRIBUTION = '© Copernicus DEM (ESA)'
# Родное разрешение источника, в зумах. Не менять, не сверившись с источником:
# по этому числу читатель архива понимает, где кончаются данные.
NATIVE_ZOOM = 12
MAXZOOM = 13
# Нижний зум — 8 (02.09, «перепеки» владельца): с 10 обзорный вид края
# оставался тёмным — ниже нижнего зума MapLibre растровый источник не
# рисует вовсе, дочерние тайлы вниз не масштабирует. z8-9 стоят ~2 % от
# объёма пакета (в четыре раза меньше тайлов на каждый уровень вниз).
MINZOOM = 8
TILE_PX = 256


def dem_tile_name(lat: int, lng: int) -> str:
    """Имя клетки Copernicus DEM по левому нижнему углу градусной клетки."""
    ns = 'N' if lat >= 0 else 'S'
    ew = 'E' if lng >= 0 else 'W'
    return (f'Copernicus_DSM_COG_{DEM_RES_CODE}_{ns}{abs(lat):02d}_00_'
            f'{ew}{abs(lng):03d}_00_DEM')


def fetch_dem_tiles(bbox, cache_dir):
    """Скачивает клетки DEM, покрывающие bbox. Возвращает список путей."""
    west, south, east, north = bbox
    os.makedirs(cache_dir, exist_ok=True)
    paths = []
    for lat in range(math.floor(south), math.ceil(north)):
        for lng in range(math.floor(west), math.ceil(east)):
            name = dem_tile_name(lat, lng)
            path = os.path.join(cache_dir, f'{name}.tif')
            if not os.path.exists(path):
                url = f'{DEM_BUCKET}/{name}/{name}.tif'
                print(f'  скачиваю {name} ...', flush=True)
                try:
                    with urllib.request.urlopen(url, timeout=300) as r:
                        data = r.read()
                except Exception as err:
                    # Клетка может отсутствовать законно: над океаном
                    # Copernicus публикует не все квадраты. Это «нет данных», а не сбой —
                    # но сказать об этом надо вслух, иначе дыра в рельефе
                    # объяснится «наверное, так и должно быть».
                    print(f'  НЕТ КЛЕТКИ {name}: {err}', file=sys.stderr)
                    continue
                with open(path, 'wb') as f:
                    f.write(data)
            paths.append(path)
    return paths


def cells_extent(bbox):
    """Целоградусный охват скачанных клеток: floor/ceil границ bbox."""
    west, south, east, north = bbox
    return (math.floor(west), math.floor(south), math.ceil(east), math.ceil(north))


def build_mosaic(paths, bbox, extent=None):
    """
    Склеивает клетки в один массив высот. Возвращает (array, transform-параметры).

    `extent` — на чём строить мозаику; по умолчанию сам bbox. Рельеф передаёт
    ЦЕЛОГРАДУСНЫЙ охват клеток (cells_extent): первый живой рендер 02.09 —
    у западного края рельеф лежал горизонтальными полосами. Тайлы z10-13
    выходят за bbox (тайл z10 — 0.35° по долготе), а выборка за краем
    мозаики зажималась в крайний столбец: каждая строка тайла получала одну
    и ту же высоту. Данные в клетках ЕСТЬ на весь градус — их и берём.

    Горизонтали охват НЕ расширяют: прогон 3 (02.09) построил их на всей
    2°x2° мозаике — 16 МБ вместо 3.3, пакет 65 МБ, потолок 60. Линиям
    за bbox взяться неоткуда и незачем: карта района кончается у района.
    """
    import rasterio

    west, south, east, north = extent if extent is not None else bbox
    # Шаг берём у первой клетки — у Copernicus DEM он одинаков в пределах
    # широтной полосы, а регион пробы в одну полосу и укладывается.
    with rasterio.open(paths[0]) as s0:
        res_x, res_y = s0.res

    width = int(round((east - west) / res_x))
    height = int(round((north - south) / res_y))
    mosaic = np.full((height, width), np.nan, dtype=np.float32)

    for p in paths:
        with rasterio.open(p) as src:
            a = src.read(1).astype(np.float32)
            if src.nodata is not None:
                a[a == src.nodata] = np.nan
            b = src.bounds
            # Куда эта клетка ложится в мозаике.
            col0 = int(round((b.left - west) / res_x))
            row0 = int(round((north - b.top) / res_y))
            r0, c0 = max(0, row0), max(0, col0)
            r1 = min(height, row0 + a.shape[0])
            c1 = min(width, col0 + a.shape[1])
            if r1 <= r0 or c1 <= c0:
                continue
            mosaic[r0:r1, c0:c1] = a[r0 - row0:r1 - row0, c0 - col0:c1 - col0]

    filled = int(np.count_nonzero(~np.isnan(mosaic)))
    return mosaic, (west, north, res_x, res_y), filled


def sample_bilinear(mosaic, geo, lats, lngs):
    """Билинейная выборка высот по сетке широт/долгот."""
    west, north, res_x, res_y = geo
    h, w = mosaic.shape
    fx = (lngs - west) / res_x
    fy = (north - lats) / res_y
    x0 = np.clip(np.floor(fx).astype(np.int32), 0, w - 1)
    y0 = np.clip(np.floor(fy).astype(np.int32), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    tx = np.clip(fx - x0, 0.0, 1.0)
    ty = np.clip(fy - y0, 0.0, 1.0)
    v00 = mosaic[y0, x0]
    v10 = mosaic[y0, x1]
    v01 = mosaic[y1, x0]
    v11 = mosaic[y1, x1]
    top = v00 * (1 - tx) + v10 * tx
    bot = v01 * (1 - tx) + v11 * tx
    return top * (1 - ty) + bot * ty


def encode_terrain_rgb(heights):
    """Высоты -> Mapbox terrain-RGB. height = -10000 + (R*65536 + G*256 + B) * 0.1"""
    h = np.where(np.isnan(heights), 0.0, heights)
    v = np.clip((h + 10000.0) * 10.0, 0, 16777215).astype(np.uint32)
    rgb = np.empty(h.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = (v >> 16) & 0xFF
    rgb[..., 1] = (v >> 8) & 0xFF
    rgb[..., 2] = v & 0xFF
    return rgb


def tile_lat_lng_grid(z, x, y):
    """Сетка широт/долгот для 256x256 пикселей тайла Web Mercator."""
    n = 2.0 ** z
    lng0 = x / n * 360.0 - 180.0
    lng1 = (x + 1) / n * 360.0 - 180.0
    # Пиксельные центры, а не края — иначе тайлы разъезжаются на полпикселя.
    px = (np.arange(TILE_PX) + 0.5) / TILE_PX
    lngs = lng0 + (lng1 - lng0) * px

    def merc_lat(yy):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    ys = y + (np.arange(TILE_PX) + 0.5) / TILE_PX
    lats = np.array([merc_lat(v) for v in ys])
    return np.meshgrid(lngs, lats)


def tile_range(bbox, z):
    west, south, east, north = bbox
    n = 2.0 ** z

    def xtile(lng):
        return int((lng + 180.0) / 360.0 * n)

    def ytile(lat):
        r = math.radians(lat)
        return int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n)

    return (xtile(west), xtile(east), ytile(north), ytile(south))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='west,south,east,north')
    ap.add_argument('--out', required=True)
    ap.add_argument('--cache', default='.cache/dem')
    ap.add_argument('--minzoom', type=int, default=MINZOOM)
    ap.add_argument('--maxzoom', type=int, default=MAXZOOM)
    args = ap.parse_args()

    bbox = tuple(float(v) for v in args.bbox.split(','))
    assert len(bbox) == 4, 'bbox = west,south,east,north'

    started = time.time()
    print(f'bbox {bbox}, зумы {args.minzoom}-{args.maxzoom}')
    paths = fetch_dem_tiles(bbox, args.cache)
    if not paths:
        # Ноль клеток при непустом bbox — это отказ, а не пустой результат
        # (§4.0: прогон, разобравший 0 из N, обязан краснеть).
        print('НИ ОДНОЙ клетки DEM не получено — прекращаю', file=sys.stderr)
        return 1
    print(f'клеток DEM: {len(paths)}')

    mosaic, geo, filled = build_mosaic(paths, bbox, extent=cells_extent(bbox))
    total = mosaic.size
    print(f'мозаика {mosaic.shape}, заполнено {filled}/{total} '
          f'({100.0 * filled / total:.1f}%)')
    if filled == 0:
        print('мозаика пуста — прекращаю', file=sys.stderr)
        return 1

    from PIL import Image
    from pmtiles.writer import Writer
    from pmtiles.tile import TileType, Compression, zxy_to_tileid

    # PMTiles требует записи в порядке tileid — копим и сортируем.
    tiles = {}
    for z in range(args.minzoom, args.maxzoom + 1):
        x0, x1, y0, y1 = tile_range(bbox, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                lngs, lats = tile_lat_lng_grid(z, x, y)
                heights = sample_bilinear(mosaic, geo, lats, lngs)
                rgb = encode_terrain_rgb(heights)
                buf = io.BytesIO()
                Image.fromarray(rgb, 'RGB').save(buf, format='PNG', optimize=True)
                tiles[zxy_to_tileid(z, x, y)] = buf.getvalue()
        print(f'  z{z}: {(x1 - x0 + 1) * (y1 - y0 + 1)} тайлов')

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'wb') as f:
        w = Writer(f)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        west, south, east, north = bbox
        w.finalize(
            {
                'tile_type': TileType.PNG,
                'tile_compression': Compression.NONE,
                'min_zoom': args.minzoom,
                'max_zoom': args.maxzoom,
                'min_lon_e7': int(west * 1e7),
                'min_lat_e7': int(south * 1e7),
                'max_lon_e7': int(east * 1e7),
                'max_lat_e7': int(north * 1e7),
                'center_zoom': args.minzoom,
                'center_lon_e7': int((west + east) / 2 * 1e7),
                'center_lat_e7': int((south + north) / 2 * 1e7),
            },
            {
                'attribution': ATTRIBUTION,
                'encoding': 'terrarium-free mapbox terrain-rgb',
                'format': 'png',
                # Родное разрешение источника. Зумы выше — билинейное
                # сглаживание ради ровной тени, НЕ добавленная детализация.
                'native_zoom': NATIVE_ZOOM,
                'source': DEM_PRODUCT,
                'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            },
        )

    size = os.path.getsize(args.out)
    print(f'готово: {args.out}')
    print(f'  тайлов: {len(tiles)}')
    print(f'  размер: {size / 1024 / 1024:.2f} МБ')
    print(f'  время сборки: {time.time() - started:.1f} с')
    return 0


if __name__ == '__main__':
    sys.exit(main())
