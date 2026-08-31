#!/usr/bin/env python3
"""
Горизонтали региона из того же DEM -> GeoJSON с высотой в атрибутах.

── Почему они отдельно от рельефа ────────────────────────────────────────

terrain-RGB даёт тень: объём, по которому глаз читает форму склона. Числа
на линиях — «1800», «1400», «600» на референсе владельца — тень дать не
может: это подписи, а подпись берётся из АТРИБУТА, иначе она нарисована.
Ровно на этом ломаются генеративные модели, и ровно поэтому горизонтали
здесь — вектор со свойством `ele`, а не картинка с цифрами.

MapLibre ставит такие подписи сам (`symbol-placement: line`, `text-field`
из `ele`): они поворачиваются вдоль линии, не налезают друг на друга и
пропадают, когда места нет. Это самая капризная часть стиля, поэтому в
пробе она отдельным чекпоинтом — требование владельца.

── Род линии называется в данных ─────────────────────────────────────────

`major` (кратные MAJOR_EVERY) несут подпись и рисуются заметнее, `minor`
молчат. Решение принимается ЗДЕСЬ, при сборке, а не подбором фильтра в
стиле: стиль читает свойство, а не пересчитывает арифметику высоты. Так же
устроен род линии маршрута (§12) — вид следует из записанного факта.

── Что здесь НЕ делается ─────────────────────────────────────────────────

Сглаживание рельефа перед построением. Соблазн большой: изолинии из сырого
90-метрового DEM угловаты, и один проход размытия делает их «красивее».
Но горизонталь — это утверждение о высоте местности, и сдвинутая ради вида
линия говорит неправду о том, где кончается склон. Упрощение (RDP) ниже
только ВЫБРАСЫВАЕТ точки, не двигая оставшиеся, и допуск задан долей
пикселя на максимальном зуме — то есть невидим по построению.

Использование:
    python3 scripts/map-tiles/build_contours.py \
        --bbox 158.4,52.8,159.4,53.6 --out public/map-packs/avacha-group.contours.geojson
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_terrain import (  # noqa: E402
    ATTRIBUTION, build_mosaic, fetch_dem_tiles,
)

# Шаг горизонталей и то, какие из них подписываются. 100/500 — обычная
# топографическая пара для гор такого масштаба; на референсе владельца
# подписаны как раз редкие линии, а частые держат форму склона.
MINOR_STEP = 100
MAJOR_EVERY = 500
# Ниже этой высоты линии не строим: 0 м — урез воды, и «горизонталь моря»
# была бы обводкой берега, а не рельефом.
MIN_ELEVATION = 100
# Допуск упрощения — доля пикселя на максимальном зуме пакета (z12).
# Считается в градусах: 22.9 м/пиксель на широте региона.
SIMPLIFY_PX = 0.35
MAXZOOM = 12


def simplify_tolerance_deg(lat: float) -> float:
    m_per_px = 156543.03392 * math.cos(math.radians(lat)) / (2 ** MAXZOOM)
    m_per_deg = 111320.0
    return SIMPLIFY_PX * m_per_px / m_per_deg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='west,south,east,north')
    ap.add_argument('--out', required=True)
    ap.add_argument('--cache', default='.cache/dem')
    args = ap.parse_args()

    bbox = tuple(float(v) for v in args.bbox.split(','))
    west, south, east, north = bbox
    started = time.time()

    paths = fetch_dem_tiles(bbox, args.cache)
    if not paths:
        print('НИ ОДНОЙ клетки DEM не получено — прекращаю', file=sys.stderr)
        return 1

    mosaic, geo, filled = build_mosaic(paths, bbox)
    if filled == 0:
        print('мозаика пуста — прекращаю', file=sys.stderr)
        return 1
    _, _, res_x, res_y = geo

    # Море и дыры покрытия -> ниже порога, чтобы не родить ложную линию по
    # краю отсутствующих данных. NaN у matplotlib и так не участвует, но
    # явный ноль честнее: он говорит «здесь уровень моря», а не «здесь никак».
    grid = np.where(np.isnan(mosaic), 0.0, mosaic)
    hmax = float(np.nanmax(mosaic))
    levels = list(range(MIN_ELEVATION,
                        int(math.ceil(hmax / MINOR_STEP)) * MINOR_STEP + 1,
                        MINOR_STEP))
    print(f'мозаика {mosaic.shape}, max {hmax:.0f} м, уровней {len(levels)}')

    lngs = west + (np.arange(grid.shape[1]) + 0.5) * res_x
    lats = north - (np.arange(grid.shape[0]) + 0.5) * res_y

    import matplotlib
    matplotlib.use('Agg')
    from matplotlib import pyplot as plt
    from shapely.geometry import LineString

    tol = simplify_tolerance_deg((south + north) / 2)
    fig = plt.figure()
    ax = fig.add_subplot(111)
    cs = ax.contour(lngs, lats, grid, levels=levels)

    features = []
    dropped_short = 0
    for level, seg_list in zip(cs.levels, cs.allsegs):
        ele = int(round(float(level)))
        is_major = ele % MAJOR_EVERY == 0
        for seg in seg_list:
            if len(seg) < 2:
                dropped_short += 1
                continue
            line = LineString(seg).simplify(tol, preserve_topology=False)
            if line.is_empty or len(line.coords) < 2:
                dropped_short += 1
                continue
            features.append({
                'type': 'Feature',
                'properties': {
                    'ele': ele,
                    # Род линии — записанный факт, а не арифметика в стиле.
                    'kind': 'major' if is_major else 'minor',
                },
                'geometry': {
                    'type': 'LineString',
                    'coordinates': [[round(x, 5), round(y, 5)] for x, y in line.coords],
                },
            })
    plt.close(fig)

    if not features:
        # Ноль линий при непустой мозаике — отказ, а не результат (§4.0).
        print('НИ ОДНОЙ горизонтали не построено — прекращаю', file=sys.stderr)
        return 1

    majors = sum(1 for f in features if f['properties']['kind'] == 'major')
    fc = {
        'type': 'FeatureCollection',
        'attribution': ATTRIBUTION,
        'contour_step_m': MINOR_STEP,
        'contour_major_every_m': MAJOR_EVERY,
        'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'features': features,
    }
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))

    size = os.path.getsize(args.out)
    print(f'готово: {args.out}')
    print(f'  линий: {len(features)} (подписываемых: {majors})')
    print(f'  отброшено вырожденных: {dropped_short}')
    print(f'  допуск упрощения: {tol:.7f} град (~{SIMPLIFY_PX} пикселя на z{MAXZOOM})')
    print(f'  размер: {size / 1024 / 1024:.2f} МБ')
    print(f'  время сборки: {time.time() - started:.1f} с')
    return 0


if __name__ == '__main__':
    sys.exit(main())
