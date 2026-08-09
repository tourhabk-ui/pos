#!/usr/bin/env python3
"""
Контур берега Камчатки для радара безопасности — из Natural Earth.

Радар рисует берег, и рисовать его по памяти нельзя: выдуманная линия на
экране безопасности — ложь о местности. Здесь исходник (Natural Earth 10 m,
общественное достояние) режется по камчатской рамке и упрощается, чтобы
уложиться в разумный размер: полный слой — мегабайты, а нам нужен контур,
читаемый в круге радиусом 200 км.

Упрощение — Дуглас-Пейкер. Он выбрасывает точки, которые лежат близко к
прямой между соседями, то есть НЕ добавляет форм, которых нет в источнике:
контур становится грубее, но не другим. Это важнее компактности — на радаре
показывается местность, а не рисунок.

Запуск (в workflow, не руками):
  python3 scripts/build-kamchatka-coastline.py <вход.geojson> <выход.json> <eps> <maxp>
"""

import json
import sys

# Камчатский край с запасом: радар центрируется на туристе, и берег нужен
# шире Авачинской бухты.
LAT_MIN, LAT_MAX = 50.0, 63.5
LNG_MIN, LNG_MAX = 154.0, 168.0


def in_box(lng: float, lat: float) -> bool:
    return LNG_MIN <= lng <= LNG_MAX and LAT_MIN <= lat <= LAT_MAX


def perpendicular_distance(p, a, b) -> float:
    """Расстояние от точки до прямой в градусах (для порога этого хватает)."""
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return ((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2) ** 0.5


def simplify(points, eps: float):
    """Дуглас-Пейкер без рекурсии: длинные линии берега упираются в предел стека."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        worst, worst_i = 0.0, -1
        for i in range(first + 1, last):
            d = perpendicular_distance(points[i], points[first], points[last])
            if d > worst:
                worst, worst_i = d, i
        if worst > eps and worst_i != -1:
            keep[worst_i] = True
            stack.append((first, worst_i))
            stack.append((worst_i, last))
    return [p for p, k in zip(points, keep) if k]


def split_by_box(coords):
    """
    Части линии внутри рамки — отдельными кусками.

    Резать по рамке обязательно: иначе линия, уходящая к Курилам, вернётся
    прямой хордой через море — ровно та ложная диагональ, из-за которой
    прежний контур и был негодным.
    """
    parts, current = [], []
    for c in coords:
        if len(c) < 2:
            continue
        lng, lat = float(c[0]), float(c[1])
        if in_box(lng, lat):
            current.append((lng, lat))
        elif current:
            if len(current) >= 2:
                parts.append(current)
            current = []
    if len(current) >= 2:
        parts.append(current)
    return parts


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    eps = float(sys.argv[3]) if len(sys.argv) > 3 else 0.004
    max_points = int(sys.argv[4]) if len(sys.argv) > 4 else 3000

    with open(src, encoding='utf-8') as fh:
        data = json.load(fh)

    raw_parts = []
    for feature in data.get('features', []):
        geom = feature.get('geometry') or {}
        if geom.get('type') == 'LineString':
            raw_parts.extend(split_by_box(geom.get('coordinates') or []))
        elif geom.get('type') == 'MultiLineString':
            for line in geom.get('coordinates') or []:
                raw_parts.extend(split_by_box(line))

    if not raw_parts:
        print('В рамке Камчатки ничего не найдено — источник изменился?', file=sys.stderr)
        return 1

    # Упрощаем и при необходимости ужесточаем порог, пока не уложимся в
    # потолок. Растить порог, а не резать куски: обрезанный кусок — это дыра
    # в берегу, а более грубая линия остаётся тем же берегом.
    for _ in range(12):
        parts = [simplify(p, eps) for p in raw_parts]
        parts = [p for p in parts if len(p) >= 2]
        total = sum(len(p) for p in parts)
        if total <= max_points:
            break
        eps *= 1.6

    parts.sort(key=len, reverse=True)
    out = {
        'source': 'Natural Earth 10m coastline (public domain)',
        'bbox': [LNG_MIN, LAT_MIN, LNG_MAX, LAT_MAX],
        'epsilonDeg': round(eps, 6),
        'parts': [[[round(lng, 4), round(lat, 4)] for lng, lat in p] for p in parts],
    }
    with open(dst, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))

    print(f'кусков: {len(parts)}, точек: {sum(len(p) for p in parts)}, порог: {eps:.5f}°')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
