#!/usr/bin/env python3
"""
Обзорный рельеф на ВЕСЬ край: z4-7, один пакет вместо ста двенадцати.

── Зачем он отдельный ────────────────────────────────────────────────────

Скрин владельца 04.09 07:42: человек смотрит на 119 км до цели, и карты
нет вовсе — только надпись «приблизьте». Причина не в данных: пакеты
района и клетки начинаются с зума 8 (build_terrain.MINZOOM,
build_vector.sh --minimum-zoom), а ниже нижнего зума MapLibre растровый
источник не рисует и вниз не масштабирует. Сколько клеток ни собери,
обзорный масштаб останется пустым — это дырка в замысле, а не в охвате.

Опустить нижний зум у всех пакетов нельзя: 112 клеток потащили бы каждая
свою копию одних и тех же мелких тайлов. Один и тот же кусок Охотского
моря лёг бы в хранилище сто раз. Поэтому обзор — ОДИН пакет на край,
ярусом ниже: z4-7 обзор, z8-13 клетки и районы. Стыка не видно, потому
что зумы не пересекаются.

── Почему нельзя просто позвать build_terrain на весь край ───────────────

`build_mosaic` держит охват в памяти целиком. Край — 20°x14°, при шаге
GLO-30 это порядка двух миллиардов точек float32, то есть ~8 ГБ на один
массив при четырёх гигабайтах у контейнера. Не «медленно», а «не
запустится».

Здесь мозаика строится ПРОРЕЖЕННОЙ на чтении: COG у Copernicus несёт
пирамиду обзоров, и rasterio через `/vsicurl` берёт нужный уровень, не
скачивая клетку целиком. При DECIMATE=16 шаг выходит ~480 м — мельче,
чем пиксель z7 (~680 м на широте 56), то есть обзор не размывается, а
качается в сотни раз меньше данных.

── Чего здесь нет ────────────────────────────────────────────────────────

Горизонталей и OSM. На z4-7 стометровая линия — это шум в полпикселя, а
не рельеф; тропа и брод на таком масштабе не читаются вовсе. Обзор
отвечает на один вопрос: «где здесь земля и куда она поднимается».
Пустой файл горизонталей рядом с пакетом — не забывчивость, а тот же
ответ словами: линий этого яруса нет.

Использование:
    python3 scripts/map-tiles/build_overview.py \
        --bbox 155,51,175,65 --out .cache/packs/overview.terrain.pmtiles \
        --contours-out .cache/packs/overview.contours.geojson
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_terrain import (  # noqa: E402
    ATTRIBUTION, DEM_BUCKET, DEM_PRODUCT, dem_tile_name,
    encode_terrain_rgb, sample_bilinear, tile_lat_lng_grid, tile_range,
)

# Зумы обзора. Верхняя граница на единицу ниже нижней границы пакетов
# (MINZOOM=8): ярусы стыкуются без нахлёста, иначе на z8 рисовались бы
# два рельефа сразу — обзорный поверх подробного или наоборот.
MINZOOM = 4
MAXZOOM = 7
# Во сколько раз прореживаем родной шаг DEM при чтении. 16 от GLO-30 —
# около 480 м, мельче пикселя z7 (~680 м на широте 56). Больше брать
# незачем: детализация, которой не видно, стоит памяти и времени.
DECIMATE = 16
TILE_PX = 256


def read_cell_decimated(lat: int, lng: int, decimate: int):
    """
    Читает одну градусную клетку DEM прореженной, прямо из бакета.

    Возвращает (array, west, north, res_x, res_y) или None, если клетки
    нет. Отсутствие — законный исход: над океаном Copernicus публикует не
    все квадраты. Но молчать о нём нельзя: дыра в рельефе иначе объяснится
    сама собой, «наверное, так и надо».
    """
    import rasterio

    name = dem_tile_name(lat, lng)
    url = f'/vsicurl/{DEM_BUCKET}/{name}/{name}.tif'
    try:
        with rasterio.open(url) as src:
            h = max(1, src.height // decimate)
            w = max(1, src.width // decimate)
            a = src.read(1, out_shape=(h, w)).astype(np.float32)
            if src.nodata is not None:
                a[a == src.nodata] = np.nan
            b = src.bounds
            return a, b.left, b.top, (b.right - b.left) / w, (b.top - b.bottom) / h
    except Exception as err:
        print(f'  нет клетки {name}: {err}', file=sys.stderr)
        return None


def build_coarse_mosaic(bbox, decimate):
    """Прореженная мозаика на целоградусном охвате bbox."""
    west, south, east, north = bbox
    w0, s0 = math.floor(west), math.floor(south)
    e0, n0 = math.ceil(east), math.ceil(north)

    # Шаг сетки задаём сами, а не берём у первой клетки: клетки края лежат
    # в разных широтных полосах, и у Copernicus шаг по долготе в них
    # РАЗНЫЙ (ближе к полюсу точек на градус меньше). Общая сетка в
    # градусах — единственное, во что они кладутся без перекосов.
    per_deg = max(1, 3600 // decimate)
    res = 1.0 / per_deg
    width = (e0 - w0) * per_deg
    height = (n0 - s0) * per_deg
    mosaic = np.full((height, width), np.nan, dtype=np.float32)

    got, missing = 0, 0
    for lat in range(s0, n0):
        for lng in range(w0, e0):
            cell = read_cell_decimated(lat, lng, decimate)
            if cell is None:
                missing += 1
                continue
            a, _, _, _, _ = cell
            # Клетка кладётся на свой градус целиком, растяжением на
            # per_deg точек: собственный шаг у неё уже прореженный и по
            # широтным полосам разный, а общая сетка одна.
            r0 = (n0 - (lat + 1)) * per_deg
            c0 = (lng - w0) * per_deg
            ys = np.clip((np.arange(per_deg) * a.shape[0] // per_deg), 0, a.shape[0] - 1)
            xs = np.clip((np.arange(per_deg) * a.shape[1] // per_deg), 0, a.shape[1] - 1)
            mosaic[r0:r0 + per_deg, c0:c0 + per_deg] = a[np.ix_(ys, xs)]
            got += 1
            print(f'  клетка {lat}N {lng}E: {a.shape[0]}x{a.shape[1]} '
                  f'(всего {got}, пропущено {missing})', flush=True)

    geo = (float(w0), float(n0), res, res)
    filled = int(np.count_nonzero(~np.isnan(mosaic)))
    return mosaic, geo, filled, got, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='west,south,east,north')
    ap.add_argument('--out', required=True)
    ap.add_argument('--contours-out', default=None,
                    help='пустой GeoJSON рядом с пакетом: у обзора горизонталей нет')
    ap.add_argument('--minzoom', type=int, default=MINZOOM)
    ap.add_argument('--maxzoom', type=int, default=MAXZOOM)
    ap.add_argument('--decimate', type=int, default=DECIMATE)
    args = ap.parse_args()

    bbox = tuple(float(v) for v in args.bbox.split(','))
    assert len(bbox) == 4, 'bbox = west,south,east,north'
    started = time.time()
    print(f'обзор края: bbox {bbox}, зумы {args.minzoom}-{args.maxzoom}, '
          f'прореживание {args.decimate}x')

    mosaic, geo, filled, got, missing = build_coarse_mosaic(bbox, args.decimate)
    total = mosaic.size
    print(f'мозаика {mosaic.shape}, клеток {got} (нет {missing}), '
          f'заполнено {filled}/{total} ({100.0 * filled / total:.1f}%)')
    if got == 0 or filled == 0:
        # Ноль клеток на весь край — отказ, а не «здесь океан» (§4.0).
        print('НИ ОДНОЙ клетки DEM не прочитано — прекращаю', file=sys.stderr)
        return 1

    from PIL import Image
    from pmtiles.writer import Writer
    from pmtiles.tile import TileType, Compression, zxy_to_tileid

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
                # Родное разрешение ОБЗОРА, а не источника: читатель архива
                # должен видеть, что здесь прореженные данные, и не ждать от
                # них подробностей склона.
                'native_zoom': args.maxzoom,
                'source': f'{DEM_PRODUCT}, прорежено {args.decimate}x',
                'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            },
        )

    size = os.path.getsize(args.out)
    print(f'готово: {args.out}')
    print(f'  тайлов: {len(tiles)}')
    print(f'  размер: {size / 1024 / 1024:.2f} МБ')

    if args.contours_out:
        # Пустой, но НАСТОЯЩИЙ GeoJSON: заливка отказывается класть файл
        # нулевой длины (пакет выглядел бы собранным при пустой карте), а
        # коллекция без объектов — честный ответ «линий этого яруса нет».
        os.makedirs(os.path.dirname(args.contours_out) or '.', exist_ok=True)
        with open(args.contours_out, 'w', encoding='utf-8') as f:
            json.dump({
                'type': 'FeatureCollection',
                'attribution': ATTRIBUTION,
                'note': 'обзорный ярус: горизонталей нет по замыслу, не по недосбору',
                'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'features': [],
            }, f, ensure_ascii=False, separators=(',', ':'))
        print(f'горизонтали обзора: {args.contours_out} (пусто по замыслу)')

    print(f'  время сборки: {time.time() - started:.1f} с')
    return 0


if __name__ == '__main__':
    sys.exit(main())
