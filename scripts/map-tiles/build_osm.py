#!/usr/bin/env python3
"""
OSM-слои района -> GeoJSON по слоям: вода, реки, лес, ледники, тропы, дороги,
вершины. Третий шаг итерации пробы 02.09 (решение владельца «го»).

── Почему отдельно и почему только сейчас ────────────────────────────────

Стиль своей карты с 31.08 честно писал: рек, леса и троп с референса нет —
их источник (OSM) недостижим из контейнера сборки (geofabrik и overpass
закрыты политикой прокси). Раннер GitHub ходит свободно, а конвейер пакета
и так исполняется на нём — значит место этому шагу здесь, рядом с рельефом.

Источник — Overpass API по bbox района. Не выписка geofabrik: для района в
80x100 км это сотни мегабайт всего Дальнего Востока ради нескольких
мегабайт. Overpass — чужой общественный сервер: один запрос на район, с
таймаутом, без повторов в цикле.

── Что попадает в слои и что нет ─────────────────────────────────────────

  water      natural=water (озёра, водохранилища) — полигоны
  waterways  waterway=river|stream|canal — линии
  wood       natural=wood | landuse=forest — полигоны
  glacier    natural=glacier — полигоны (на вулканах — это ориентир)
  paths      highway=path|track|footway|bridleway — линии
  roads      остальные highway (от service до primary) — линии
  peaks      natural=peak|volcano с именем — точки (name, ele)

Остального (здания, границы, ЛЭП) нет намеренно: полевая карта — не
городская. Свойства обрезаются до name/ele/kind — карте больше не нужно,
а пакет должен помещаться в телефон.

── Честность ─────────────────────────────────────────────────────────────

Ноль элементов от Overpass при непустом bbox — ОТКАЗ, не пустой район (§4.0):
на Камчатке нет места без единой реки. Пустой ОТДЕЛЬНЫЙ слой (нет ледников)
законен и пишется пустой коллекцией с счётчиком в лог.

Атрибуция обязательна: © OpenStreetMap contributors (ODbL). Она несётся в
метаданных каждого слоя и выводится на экран из источника стиля.

Использование:
    python3 scripts/map-tiles/build_osm.py \
        --bbox 158.4,52.8,159.4,53.6 --out-prefix .cache/packs/avacha-group
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_contours import simplify_tolerance_deg  # noqa: E402

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
OSM_ATTRIBUTION = '© OpenStreetMap contributors'

LAYERS = ('water', 'waterways', 'wood', 'glacier', 'paths', 'roads', 'peaks')
PATH_HIGHWAYS = {'path', 'track', 'footway', 'bridleway'}
ROAD_HIGHWAYS = {
    'service', 'residential', 'unclassified', 'tertiary', 'secondary',
    'primary', 'trunk', 'living_street', 'road',
}


def overpass_query(bbox) -> str:
    west, south, east, north = bbox
    bb = f'{south},{west},{north},{east}'
    hw = '|'.join(sorted(PATH_HIGHWAYS | ROAD_HIGHWAYS))
    return f"""
[out:json][timeout:240];
(
  way["natural"="water"]({bb});
  relation["natural"="water"]({bb});
  way["waterway"~"^(river|stream|canal)$"]({bb});
  way["natural"="wood"]({bb});
  relation["natural"="wood"]({bb});
  way["landuse"="forest"]({bb});
  relation["landuse"="forest"]({bb});
  way["natural"="glacier"]({bb});
  relation["natural"="glacier"]({bb});
  way["highway"~"^({hw})$"]({bb});
  node["natural"~"^(peak|volcano)$"]["name"]({bb});
);
out body;
>;
out skel qt;
"""


def fetch_overpass(query: str, url: str, cache_path: str) -> dict:
    if os.path.exists(cache_path):
        with open(cache_path, encoding='utf-8') as f:
            return json.load(f)
    data = urllib.parse.urlencode({'data': query}).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'User-Agent': 'VedarMapPack/1.0'})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
    os.makedirs(os.path.dirname(cache_path) or '.', exist_ok=True)
    with open(cache_path, 'wb') as f:
        f.write(raw)
    return json.loads(raw.decode('utf-8'))


def classify(tags: dict, geom_type: str) -> str | None:
    """Слой по тегам и геометрии. None — не наш элемент (напр. служебный узел)."""
    if geom_type == 'Point':
        return 'peaks' if tags.get('natural') in ('peak', 'volcano') and tags.get('name') else None
    if geom_type in ('Polygon', 'MultiPolygon'):
        if tags.get('natural') == 'water':
            return 'water'
        if tags.get('natural') == 'wood' or tags.get('landuse') == 'forest':
            return 'wood'
        if tags.get('natural') == 'glacier':
            return 'glacier'
        return None
    if geom_type in ('LineString', 'MultiLineString'):
        if tags.get('waterway') in ('river', 'stream', 'canal'):
            return 'waterways'
        hw = tags.get('highway')
        if hw in PATH_HIGHWAYS:
            return 'paths'
        if hw in ROAD_HIGHWAYS:
            return 'roads'
        return None
    return None


def slim_properties(tags: dict, layer: str) -> dict:
    """Только то, что читает карта. Остальное — вес без пользы."""
    out: dict = {'kind': tags.get('highway') or tags.get('waterway') or tags.get('natural') or tags.get('landuse') or layer}
    if tags.get('name'):
        out['name'] = tags['name']
    if layer == 'peaks' and tags.get('ele'):
        try:
            out['ele'] = int(float(str(tags['ele']).replace(',', '.').split()[0]))
        except ValueError:
            pass
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='west,south,east,north')
    ap.add_argument('--out-prefix', required=True, help='напр. .cache/packs/avacha-group')
    ap.add_argument('--overpass', default=OVERPASS_URL)
    ap.add_argument('--cache', default='.cache/osm')
    args = ap.parse_args()

    bbox = tuple(float(v) for v in args.bbox.split(','))
    assert len(bbox) == 4, 'bbox = west,south,east,north'
    started = time.time()

    import osm2geojson
    from shapely.geometry import shape, mapping

    cache_path = os.path.join(args.cache, f'overpass_{"_".join(str(v) for v in bbox)}.json')
    print(f'Overpass {args.overpass}, bbox {bbox}')
    data = fetch_overpass(overpass_query(bbox), args.overpass, cache_path)
    elements = data.get('elements', [])
    if not elements:
        print('Overpass вернул НОЛЬ элементов — отказ, не пустой район', file=sys.stderr)
        return 1
    print(f'элементов от Overpass: {len(elements)}')

    fc = osm2geojson.json2geojson(data)
    tol = simplify_tolerance_deg((bbox[1] + bbox[3]) / 2)
    layers: dict[str, list] = {name: [] for name in LAYERS}
    skipped = 0
    for feat in fc.get('features', []):
        geom = feat.get('geometry')
        props = feat.get('properties') or {}
        tags = props.get('tags') or {}
        if not geom:
            skipped += 1
            continue
        layer = classify(tags, geom['type'])
        if layer is None:
            skipped += 1
            continue
        g = shape(geom)
        if geom['type'] != 'Point':
            g = g.simplify(tol, preserve_topology=True)
            if g.is_empty:
                skipped += 1
                continue
        layers[layer].append({
            'type': 'Feature',
            'properties': slim_properties(tags, layer),
            'geometry': mapping(g),
        })

    total = 0
    for name in LAYERS:
        feats = layers[name]
        path = f'{args.out_prefix}.osm.{name}.geojson'
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({
                'type': 'FeatureCollection',
                'attribution': OSM_ATTRIBUTION,
                'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'features': feats,
            }, f, ensure_ascii=False, separators=(',', ':'))
        size = os.path.getsize(path)
        total += size
        print(f'  {name:10s} {len(feats):6d} объектов  {size / 1024:8.0f} КБ')
    print(f'пропущено (не наш слой / без геометрии): {skipped}')
    print(f'итого OSM: {total / 1024 / 1024:.2f} МБ, время {time.time() - started:.1f} с')
    return 0


if __name__ == '__main__':
    sys.exit(main())
