#!/usr/bin/env python3
"""
OSM-слои района -> GeoJSON по слоям: вода, реки, лес, ледники, тропы, дороги,
вершины, посёлки, приюты, перевалы. Третий шаг итерации пробы 02.09
(решение владельца «го»), имена добавлены тем же вечером после осмотра.

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
  places     place=city|town|village|hamlet с именем — точки
  shelters   tourism=alpine_hut|wilderness_hut, amenity=shelter — точки
  passes     mountain_pass=yes | natural=saddle — точки (name, ele)

Последние три заведены 02.09 после осмотра владельцем: на карте не было
ни одного названия населённого пункта, а приют и перевал в поле — это
решение «где ночевать» и «где переваливать», то есть ровно то, ради чего
карту открывают. Свойства обрезаются до name/ele/kind — карте больше не
нужно, а пакет должен помещаться в телефон.

Приют и укрытие бывают размечены и точкой, и контуром здания. Контур
сводится к точке (representative_point): на полевой карте это символ, а
не постройка в масштабе, и полигон в 8 метров на зуме 12 — невидимая
клякса ценой лишних координат.

Остального (здания, границы, ЛЭП) нет намеренно: полевая карта — не
городская.

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
import hashlib
import http.client
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

LAYERS = (
    'water', 'waterways', 'wood', 'glacier', 'paths', 'roads', 'peaks',
    'places', 'shelters', 'passes',
)
PATH_HIGHWAYS = {'path', 'track', 'footway', 'bridleway'}
ROAD_HIGHWAYS = {
    'service', 'residential', 'unclassified', 'tertiary', 'secondary',
    'primary', 'trunk', 'living_street', 'road',
}
# Населённые пункты полевого масштаба. Ниже hamlet (isolated_dwelling,
# farm) не берём: на Камчатке это чаще всего один домик без имени.
PLACE_KINDS = {'city', 'town', 'village', 'hamlet'}
SHELTER_TOURISM = {'alpine_hut', 'wilderness_hut'}
# Слои, которые на карте — символ, а не фигура. Контур сводится к точке.
POINT_LAYERS = {'peaks', 'places', 'shelters', 'passes'}


def tile_minzoom(layer: str, tags: dict) -> int:
    """С какого зума объект кладётся в векторный тайл (tippecanoe).

    Ниже — объекта в тайле нет. Это не потеря, а честная обзорность: ручей
    и тропа на z9 — шум в пиксель, а посёлок и вершина — ориентир уже с z8.
    Крупные дороги видны раньше просёлков.
    """
    if layer in ('peaks', 'places'):
        return 8
    if layer in ('shelters', 'passes', 'water', 'wood', 'glacier'):
        return 9
    if layer == 'waterways':
        return 9 if tags.get('waterway') == 'river' else 11
    if layer == 'roads':
        return 8 if tags.get('highway') in ('primary', 'trunk', 'secondary') else 10
    if layer == 'paths':
        return 11
    return 10


def overpass_query(bbox) -> str:
    west, south, east, north = bbox
    bb = f'{south},{west},{north},{east}'
    hw = '|'.join(sorted(PATH_HIGHWAYS | ROAD_HIGHWAYS))
    pl = '|'.join(sorted(PLACE_KINDS))
    sh = '|'.join(sorted(SHELTER_TOURISM))
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


def symbols_query(bbox) -> str:
    """Имена: посёлки, приюты, перевалы — ОТДЕЛЬНЫМ запросом на весь район.

    Отдельным по двум причинам, и обе — про цену ошибки, а не про красоту:

     1. Кэш клеток ключуется координатами клетки (см. fetch_overpass). Добавь
        эти теги в тяжёлый запрос — ключ не изменится, кэш вернёт ОТВЕТ НА
        ДРУГОЙ ВОПРОС, и три новых слоя выйдут пустыми у всех десяти районов.
        Пустой слой при этом законен (ледников бывает и правда нет), так что
        соврало бы тихо.
     2. Это узлы с редкими тегами: на весь район их сотни, а не десятки
        тысяч. Резать их на клетки по 0.25° незачем — один запрос отвечает
        за секунды там, где геометрия требует сорока.
    """
    west, south, east, north = bbox
    bb = f'{south},{west},{north},{east}'
    pl = '|'.join(sorted(PLACE_KINDS))
    sh = '|'.join(sorted(SHELTER_TOURISM))
    return f"""
[out:json][timeout:180];
(
  node["place"~"^({pl})$"]["name"]({bb});
  node["tourism"~"^({sh})$"]({bb});
  way["tourism"~"^({sh})$"]({bb});
  node["amenity"="shelter"]({bb});
  way["amenity"="shelter"]({bb});
  node["mountain_pass"="yes"]({bb});
  node["natural"="saddle"]({bb});
);
out body;
>;
out skel qt;
"""


# Зеркала Overpass: основной узел на большом bbox отвечает 504 (прогон 8,
# «Центральные вулканы» 1.8x1.1°, 02.09). Второй узел — на подмену, а не
# «для скорости»: запрос тот же, данные те же.
OVERPASS_MIRRORS = (
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
)
# Клетка запроса. Районы до 1 кв.° (Авачинская, Мутновский, Налычево)
# проходили одним запросом; 2 кв.° — 504 за десять секунд. Полградуса на
# полградуса — четверть квадратного градуса, вчетверо меньше худшего из
# прошедших: запас, а не догадка.
CELL_DEG = 0.25
# Прогон 10 (02.09): главный узел отвечал 504/429 сразу и успешно — с
# четвёртой попытки, после суммарной паузы ~150 с; зеркала kumi и
# private.coffee давали 502/500 каждый раз. Поэтому ждём дольше и ходим
# на главный узел, зеркала — только в хвосте.
RETRY_DELAYS_S = (30, 60, 120, 180, 300)
# Пауза между клетками: прогон 9 получил 429 на седьмой клетке подряд —
# узел считает частые запросы одним клиентом и режет. Секунды дешевле
# повторов.
CELL_PAUSE_S = 3
# Ниже этого клетка не дробится: 0.125° — 1/16 кв.° x 1/16, дальше сама
# сетка обходится дороже данных.
MIN_CELL_DEG = 0.125


def split_bbox(bbox, cell_deg: float = CELL_DEG) -> list:
    """bbox -> клетки не крупнее cell_deg по каждой оси. Порядок: с юга на север, с запада на восток."""
    west, south, east, north = bbox
    cells = []
    lat = south
    while lat < north - 1e-9:
        lat2 = min(north, lat + cell_deg)
        lng = west
        while lng < east - 1e-9:
            lng2 = min(east, lng + cell_deg)
            cells.append((round(lng, 4), round(lat, 4), round(lng2, 4), round(lat2, 4)))
            lng = lng2
        lat = lat2
    return cells


def fetch_overpass(query: str, url: str, cache_path: str) -> dict:
    """Один запрос с повторами по узлам и паузам. Ответ ложится в кэш ЦЕЛИКОМ.

    Отказ всех попыток — исключение, не пустой ответ (§4.0): пустой словарь
    прочитался бы как «в клетке ничего нет», и лес с реками исчезли бы молча.
    """
    if os.path.exists(cache_path):
        with open(cache_path, encoding='utf-8') as f:
            return json.load(f)
    data = urllib.parse.urlencode({'data': query}).encode('utf-8')
    urls = [url, url, url] + [m for m in OVERPASS_MIRRORS if m != url]
    last_err: Exception | None = None
    for attempt, delay in enumerate((0,) + RETRY_DELAYS_S):
        if delay:
            print(f'  повтор через {delay} с (попытка {attempt + 1})', flush=True)
            time.sleep(delay)
        u = urls[attempt % len(urls)]
        req = urllib.request.Request(u, data=data, headers={'User-Agent': 'VedarMapPack/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read()
            parsed = json.loads(raw.decode('utf-8'))
            if 'elements' not in parsed:
                raise RuntimeError(f'ответ без elements от {u}: {raw[:200]!r}')
            os.makedirs(os.path.dirname(cache_path) or '.', exist_ok=True)
            with open(cache_path, 'wb') as f:
                f.write(raw)
            return parsed
        # OSError покрывает и RemoteDisconnected (http.client), и обрыв
        # сокета: прогон 11 (02.09) снял 39 клеток из 40 и упал на последней
        # не отказом узла, а «Remote end closed connection» — исключением,
        # которого в этом списке не было, и повторы до него не дошли.
        # http.client.HTTPException — оборванное чтение тела (IncompleteRead,
        # прогон 13 Ключевской: узел закрыл поток на 110 КБ). Не OSError.
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError, ValueError, OSError,
                http.client.HTTPException) as e:
            last_err = e
            print(f'  {u}: {e}', flush=True)
    raise RuntimeError(f'Overpass не ответил после {1 + len(RETRY_DELAYS_S)} попыток: {last_err}')


def fetch_cell_adaptive(cell, url: str, cache_dir: str, depth: int = 0) -> list:
    """Клетка целиком, а при отказе всех попыток — четвертями, рекурсивно.

    Прогон 9 (02.09): клетки 0.5° отдавали по 80 тысяч элементов, и седьмая
    легла на всех трёх узлах. Дробление — не «попробовать ещё раз», а
    уменьшение запроса вчетверо; ниже MIN_CELL_DEG отказ честно всплывает.
    """
    cache_path = os.path.join(cache_dir, f'overpass_{"_".join(str(v) for v in cell)}.json')
    indent = '  ' * (depth + 1)
    try:
        data = fetch_overpass(overpass_query(cell), url, cache_path)
        return data.get('elements', [])
    except RuntimeError as e:
        w, s_, e_, n = cell
        size = max(e_ - w, n - s_)
        if size / 2 < MIN_CELL_DEG - 1e-9:
            raise
        print(f'{indent}клетка {cell} не отвечает ({e}); делю на четыре', flush=True)
        out: list = []
        for sub in split_bbox(cell, size / 2):
            print(f'{indent}  подклетка {sub}', flush=True)
            time.sleep(CELL_PAUSE_S)
            out.extend(fetch_cell_adaptive(sub, url, cache_dir, depth + 1))
        return out


def fetch_symbols(bbox, url: str, cache_dir: str) -> list:
    """Слои-символы одним запросом на район. Кэш — по bbox И по отпечатку
    запроса: изменишь состав тегов — файл будет другой, и старый ответ не
    выдаст себя за новый."""
    q = symbols_query(bbox)
    sig = hashlib.sha1(q.encode('utf-8')).hexdigest()[:8]
    name = 'symbols_' + '_'.join(str(v) for v in bbox) + f'_{sig}.json'
    print(f'символы (посёлки, приюты, перевалы) одним запросом: {name}', flush=True)
    data = fetch_overpass(q, url, os.path.join(cache_dir, name))
    els = data.get('elements', [])
    print(f'  элементов: {len(els)}', flush=True)
    return els


def fetch_overpass_cells(bbox, url: str, cache_dir: str) -> dict:
    """Район по клеткам; элементы сливаются по (type, id) — объект на стыке
    клеток приходит дважды, и второй экземпляр отбрасывается."""
    cells = split_bbox(bbox)
    print(f'клеток Overpass: {len(cells)} (по {CELL_DEG}°)', flush=True)
    seen: set = set()
    elements: list = []
    for i, cell in enumerate(cells, 1):
        print(f'[{i}/{len(cells)}] клетка {cell}', flush=True)
        if i > 1:
            time.sleep(CELL_PAUSE_S)
        n = 0
        for el in fetch_cell_adaptive(cell, url, cache_dir):
            key = (el.get('type'), el.get('id'))
            if key in seen:
                continue
            seen.add(key)
            elements.append(el)
            n += 1
        print(f'  новых элементов: {n}', flush=True)
    return {'elements': elements}


def classify_symbol(tags: dict) -> str | None:
    """Слой-символ по тегам, независимо от того, точкой или контуром размечено.

    Порядок проверок — от частного к общему: у приюта на перевале есть и
    tourism, и mountain_pass, и он прежде всего приют (там ночуют).
    """
    if tags.get('natural') in ('peak', 'volcano') and tags.get('name'):
        return 'peaks'
    if tags.get('tourism') in SHELTER_TOURISM or tags.get('amenity') == 'shelter':
        return 'shelters'
    if tags.get('mountain_pass') == 'yes' or tags.get('natural') == 'saddle':
        return 'passes'
    if tags.get('place') in PLACE_KINDS and tags.get('name'):
        return 'places'
    return None


def classify(tags: dict, geom_type: str) -> str | None:
    """Слой по тегам и геометрии. None — не наш элемент (напр. служебный узел)."""
    if geom_type == 'Point':
        return classify_symbol(tags)
    if geom_type in ('Polygon', 'MultiPolygon'):
        # Приют, размеченный контуром здания, — тот же приют. Проверяется до
        # заливок: у домика в лесу может стоять и landuse.
        symbol = classify_symbol(tags)
        if symbol is not None:
            return symbol
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
    out: dict = {'kind': (
        tags.get('highway') or tags.get('waterway') or tags.get('place')
        or tags.get('tourism') or tags.get('amenity')
        or tags.get('natural') or tags.get('landuse') or layer
    )}
    if tags.get('name'):
        out['name'] = tags['name']
    # Высота перевала — такой же факт для решения, как высота вершины:
    # по ней считают набор и понимают, будет ли там снег.
    if layer in ('peaks', 'passes') and tags.get('ele'):
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

    # Кэш — по клеткам (см. fetch_overpass_cells), не по району целиком.
    print(f'Overpass {args.overpass}, bbox {bbox}')
    data = fetch_overpass_cells(bbox, args.overpass, args.cache)
    elements = data.get('elements', [])
    if not elements:
        print('Overpass вернул НОЛЬ элементов — отказ, не пустой район', file=sys.stderr)
        return 1
    print(f'элементов от Overpass: {len(elements)}')

    # Символы — вторым запросом, на весь район (см. symbols_query). Слияние
    # по (type, id): узел приюта мог прийти и с геометрией как член way.
    seen = {(el.get('type'), el.get('id')) for el in elements}
    added = 0
    for el in fetch_symbols(bbox, args.overpass, args.cache):
        key = (el.get('type'), el.get('id'))
        if key in seen:
            continue
        seen.add(key)
        elements.append(el)
        added += 1
    print(f'символов добавлено: {added}, всего элементов: {len(elements)}')
    data = {'elements': elements}

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
        if layer in POINT_LAYERS:
            # Символьный слой: контур здания приюта сводится к точке внутри
            # него (representative_point, а не centroid — тот у подковообразной
            # постройки лёг бы снаружи).
            if geom['type'] != 'Point':
                if g.is_empty:
                    skipped += 1
                    continue
                g = g.representative_point()
        elif geom['type'] != 'Point':
            g = g.simplify(tol, preserve_topology=True)
            if g.is_empty:
                skipped += 1
                continue
        layers[layer].append({
            'type': 'Feature',
            # Читает tippecanoe при сборке тайлов; MapLibre по GeoJSON не видит.
            'tippecanoe': {'minzoom': tile_minzoom(layer, tags)},
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
