#!/usr/bin/env python3
"""
Самотест мозаики DEM на стыке широтных полос — запускается сборкой пакета
ДО сборки рельефа (map-pack-build.yml), там, где стоит rasterio.

── Зачем (24.09) ──────────────────────────────────────────────────────────

У Copernicus DEM шаг по долготе меняется на 50° (1" -> 1.5") и на 60°
(1.5" -> 2"); по широте он везде 1". Мозаика брала шаг у первой клетки и
копировала остальные пиксель в пиксель. Запас DEM (05.09) тянет в мозаику
клетки соседней полосы, и клетка чужой полосы ложилась сжатой в две трети
(или три четверти) градуса, а остаток оставался «нет данных». У клетки
мыса Лопатка так пропал кончик полуострова.

Самотест строит мозаику из синтетических клеток двух полос в обоих порядках
и проверяет: полоса заполнена целиком, и столбец на заданной долготе несёт
значение своей долготы. Провал — выход с кодом 1, и сборка не продолжается:
рельеф, собранный кривой мозаикой, хуже отсутствующего.

    python3 scripts/map-tiles/check_mosaic_bands.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile

import numpy as np
import rasterio
from rasterio.transform import from_bounds

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('build_terrain', os.path.join(HERE, 'build_terrain.py'))
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)


def write_cell(path: str, lat: int, lng: int, cols: int, rows: int = 36) -> None:
    """Клетка, где значение пикселя = долгота центра его столбца * 100."""
    xs = lng + (np.arange(cols) + 0.5) / cols
    a = np.tile((xs * 100).astype(np.float32), (rows, 1))
    tr = from_bounds(lng, lat, lng + 1, lat + 1, cols, rows)
    with rasterio.open(path, 'w', driver='GTiff', width=cols, height=rows, count=1,
                       dtype='float32', crs='EPSG:4326', transform=tr, nodata=-32767) as dst:
        dst.write(a, 1)


def check(name: str, cells: list[tuple[int, int, int]], extent, probes) -> list[str]:
    errors: list[str] = []
    with tempfile.TemporaryDirectory() as d:
        paths = []
        for lat, lng, cols in cells:
            p = os.path.join(d, f'{lat}_{lng}.tif')
            write_cell(p, lat, lng, cols)
            paths.append(p)
        mosaic, geo, filled = bt.build_mosaic(paths, None, extent=extent)
        west, north, rx, ry = geo
        if filled != mosaic.size:
            errors.append(f'{name}: заполнено {filled} из {mosaic.size} — часть градуса осталась «нет данных»')
        for lat, lng in probes:
            r = int((north - lat) / ry)
            c = int((lng - west) / rx)
            v = float(mosaic[r, c])
            if not np.isfinite(v) or abs(v - lng * 100) > 3:
                errors.append(f'{name}: на {lat}/{lng} лежит {v}, ожидалось ~{lng * 100:.0f}')
    return errors


def main() -> int:
    errors: list[str] = []
    probes = [(50.5, 156.85), (49.5, 156.85), (50.5, 156.1)]
    # 49°/50°: 1" против 1.5" — случай мыса Лопатка; в обоих порядках чтения.
    errors += check('49-50, мелкая первой', [(49, 156, 36), (50, 156, 24)], (156, 49, 157, 51), probes)
    errors += check('49-50, крупная первой', [(50, 156, 24), (49, 156, 36)], (156, 49, 157, 51), probes)
    # 59°/60°: 1.5" против 2" — клетки севера края.
    errors += check('59-60', [(59, 165, 24), (60, 165, 18)], (165, 59, 166, 61), [(60.5, 165.9), (59.5, 165.9)])
    # Одна полоса — пересчёта нет, и результат прежний.
    errors += check('одна полоса', [(55, 158, 24), (55, 159, 24)], (158, 55, 160, 56), [(55.5, 158.2), (55.5, 159.9)])
    if errors:
        for e in errors:
            print(f'ОТКАЗ мозаики: {e}', file=sys.stderr)
        return 1
    print('мозаика DEM: стыки полос 50° и 60° и одна полоса — верно')
    return 0


if __name__ == '__main__':
    sys.exit(main())
