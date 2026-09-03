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
# Частые горизонтали для векторного пакета (02.09, «качественно прорисованная
# карта»): бумажная топокарта даёт 20-40 м, у нас было 100. В GeoJSON такой
# шаг весил бы у Эссо ~80 МБ и качался бы целиком — поэтому частые линии
# идут ОТДЕЛЬНЫМ файлом и только в тайлы (tippecanoe), с 13-го зума.
FINE_STEP = 20
# С какого зума tippecanoe кладёт линию в тайл. Ниже — линии нет вовсе, и
# это не потеря: на z10 20-метровые горизонтали слились бы в заливку.
TILE_MINZOOM = {'major': 8, 'minor': 11, 'fine': 13}
# Ниже этой высоты линии не строим: 0 м — урез воды, и «горизонталь моря»
# была бы обводкой берега, а не рельефом.
MIN_ELEVATION = 100
# Допуск упрощения — доля пикселя на максимальном зуме пакета рельефа.
# Считается в градусах от м/пиксель на широте региона.
SIMPLIFY_PX = 0.35
# Предел зума — ТОТ ЖЕ, что у рельефа, из того же файла: горизонталь
# упрощается под зум, на котором её смотрят. Своя копия числа разъехалась
# бы молча (02.09: рельеф ушёл на z13 с GLO-30, горизонтали остались бы
# грубыми под z12).
from build_terrain import MAXZOOM  # noqa: E402


def simplify_tolerance_deg(lat: float) -> float:
    m_per_px = 156543.03392 * math.cos(math.radians(lat)) / (2 ** MAXZOOM)
    m_per_deg = 111320.0
    return SIMPLIFY_PX * m_per_px / m_per_deg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='west,south,east,north')
    ap.add_argument('--out', required=True)
    ap.add_argument('--fine-out', default=None,
                    help='частые горизонтали (FINE_STEP) отдельным файлом — только для тайлов')
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

    def trace(levels_, kind_of):
        """Линии matplotlib -> объекты GeoJSON с родом и зумом тайла."""
        fig = plt.figure()
        ax = fig.add_subplot(111)
        cs = ax.contour(lngs, lats, grid, levels=levels_)
        feats, short = [], 0
        for level, seg_list in zip(cs.levels, cs.allsegs):
            ele = int(round(float(level)))
            kind = kind_of(ele)
            for seg in seg_list:
                if len(seg) < 2:
                    short += 1
                    continue
                line = LineString(seg).simplify(tol, preserve_topology=False)
                if line.is_empty or len(line.coords) < 2:
                    short += 1
                    continue
                feats.append({
                    'type': 'Feature',
                    # Ключ читает tippecanoe и в тайл не кладёт; MapLibre по
                    # GeoJSON его не видит. Один файл — два потребителя.
                    'tippecanoe': {'minzoom': TILE_MINZOOM[kind]},
                    'properties': {
                        'ele': ele,
                        # Род линии — записанный факт, а не арифметика в стиле.
                        'kind': kind,
                    },
                    'geometry': {
                        'type': 'LineString',
                        'coordinates': [[round(x, 5), round(y, 5)] for x, y in line.coords],
                    },
                })
        plt.close(fig)
        return feats, short

    features, dropped_short = trace(levels, lambda e: 'major' if e % MAJOR_EVERY == 0 else 'minor')

    if not features:
        # Ноль линий — не один исход, а два разных факта (§4.0), и клетки
        # сетки (03.09, «вся Камчатка») впервые развели их на практике:
        # cell-53n155e, юго-западное побережье, max 57 м — весь рельеф ниже
        # первой ступени (MIN_ELEVATION=100), и это ПРАВДА о низком береге,
        # а не сломанная трассировка.
        #
        #   hmax < MIN_ELEVATION — рельеф генетически ниже первой горизонтали.
        #     Гористый район так не отвечает никогда; прибрежная клетка —
        #     честно. Пишем пустые файлы (пакет останется без 100/500-метровых
        #     линий у этой клетки, как он и есть) и продолжаем;
        #   hmax >= MIN_ELEVATION, а линий всё равно нет — противоречие:
        #     мозаика утверждает рельеф выше первой ступени, трассировка не
        #     нашла ни одной линии. Это отказ трассировки, не факт о земле.
        if hmax < MIN_ELEVATION:
            print(f'рельеф ниже первой горизонтали (max {hmax:.0f} м < {MIN_ELEVATION} м) '
                  '— линий нет, это не сбой')
        else:
            print('НИ ОДНОЙ горизонтали не построено — прекращаю', file=sys.stderr)
            return 1

    def write(path, feats, step):
        fc = {
            'type': 'FeatureCollection',
            'attribution': ATTRIBUTION,
            'contour_step_m': step,
            'contour_major_every_m': MAJOR_EVERY,
            'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'features': feats,
        }
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
        return os.path.getsize(path)

    majors = sum(1 for f in features if f['properties']['kind'] == 'major')
    size = write(args.out, features, MINOR_STEP)
    print(f'готово: {args.out}')
    print(f'  линий: {len(features)} (подписываемых: {majors})')
    print(f'  отброшено вырожденных: {dropped_short}')
    print(f'  допуск упрощения: {tol:.7f} град (~{SIMPLIFY_PX} пикселя на z{MAXZOOM})')
    print(f'  размер: {size / 1024 / 1024:.2f} МБ')

    if args.fine_out:
        # Только те уровни, которых нет в основном файле: 20, 40, 60, 80, 120…
        # Тайл собирается из обоих файлов, и дубль 100-метровой линии лёг бы
        # поверх самой себя.
        fine_levels = [lv for lv in range(MIN_ELEVATION, levels[-1] + 1, FINE_STEP)
                       if lv % MINOR_STEP != 0]
        fine, fine_short = trace(fine_levels, lambda e: 'fine')
        fsize = write(args.fine_out, fine, FINE_STEP)
        print(f'частые ({FINE_STEP} м): {args.fine_out}')
        print(f'  линий: {len(fine)}, отброшено вырожденных: {fine_short}')
        print(f'  размер: {fsize / 1024 / 1024:.2f} МБ (в тайлы, не в хранилище)')

    print(f'  время сборки: {time.time() - started:.1f} с')
    return 0


if __name__ == '__main__':
    sys.exit(main())
