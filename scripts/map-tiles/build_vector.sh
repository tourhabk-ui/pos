#!/usr/bin/env bash
# scripts/map-tiles/build_vector.sh — все линейные и площадные слои района в
# ОДИН векторный PMTiles (02.09, «качественно прорисованная карта»).
#
# ── Зачем ─────────────────────────────────────────────────────────────────
#
# До этого горизонтали и OSM лежали GeoJSON-файлами, и MapLibre качал каждый
# ЦЕЛИКОМ: 16 МБ горизонталей Эссо ради одного экрана. Отсюда же шаг 100 м —
# частые линии не поместились бы в телефон. Тайлы читаются кусками через
# Range, как рельеф, и несут на каждом зуме ровно то, что на нём видно:
# tippecanoe режет по зумам, упрощает и отбрасывает лишнее сам.
#
# ── Что внутри ────────────────────────────────────────────────────────────
#
#   contours       100/500 м (kind minor/major), с z8 и z11
#   contours_fine  20 м (kind fine), с z13
#   water, waterways, wood, glacier, paths, roads, peaks, places, shelters,
#   passes — те же слои, что и в GeoJSON, с зумом на каждом объекте
#   (ключ tippecanoe.minzoom пишут build_contours.py и build_osm.py).
#
# Имена слоёв — контракт со стилем (lib/map/vedar-style.ts, source-layer);
# сторож tests/unit/map-pack-vector.test.ts сверяет список с OSM_LAYERS.
#
# Использование:
#   scripts/map-tiles/build_vector.sh <out-prefix> <out.pmtiles>
#   где <out-prefix>.contours.geojson, <out-prefix>.contours-fine.geojson,
#   <out-prefix>.osm.<layer>.geojson — уже собраны.
set -euo pipefail

PREFIX="${1:?out-prefix}"
OUT="${2:?out.pmtiles}"

command -v tippecanoe >/dev/null || { echo "tippecanoe не установлен" >&2; exit 1; }

LAYERS=(water waterways wood glacier paths roads peaks places shelters passes)
ARGS=(-L "contours:${PREFIX}.contours.geojson")
if [ -s "${PREFIX}.contours-fine.geojson" ]; then
  ARGS+=(-L "contours_fine:${PREFIX}.contours-fine.geojson")
fi
for l in "${LAYERS[@]}"; do
  f="${PREFIX}.osm.${l}.geojson"
  # Слой обязан существовать (пустая коллекция — законно); отсутствие файла —
  # это дыра в сборке, а не «в районе нет ледников».
  [ -f "$f" ] || { echo "нет файла слоя ${l}: $f" >&2; exit 1; }
  ARGS+=(-L "${l}:${f}")
done

# -Z 8 / -z 14: тот же нижний зум, что у рельефа; 14 — предел, выше которого
#   30-метровый рельеф всё равно ничего не добавляет, а тайлы растут вчетверо
#   на уровень.
# --drop-densest-as-needed / --coalesce-densest-as-needed: на обзорных зумах
#   лишние объекты выбрасываются и склеиваются, а не раздувают тайл.
# --extend-zooms-if-still-dropping: если на z14 всё ещё тесно — печь глубже.
# --simplification=4: упрощение под зум, в пикселях; линия на z14 остаётся
#   той же, что в GeoJSON.
# --detect-shared-borders: смежные полигоны леса не расходятся при упрощении.
# --no-tile-compression НЕ ставим: pmtiles в MapLibre читает gzip сам.
tippecanoe -o "$OUT" --force \
  --minimum-zoom=8 --maximum-zoom=14 \
  --drop-densest-as-needed --coalesce-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --simplification=4 --detect-shared-borders \
  --attribution="© OpenStreetMap contributors, © Copernicus DEM (ESA)" \
  --name="Ведар — векторные слои района" \
  "${ARGS[@]}"

SZ=$(stat -c %s "$OUT")
echo "векторный пакет: $OUT, $((SZ / 1024 / 1024)) МБ ($SZ Б)"
