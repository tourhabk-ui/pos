/**
 * scripts/road-graph-builder.js
 *
 * Чистые функции построения дорожного графа из OSM-ways (Overpass out geom).
 * CJS без зависимостей — используется скриптом импорта на раннере GitHub
 * Actions и юнит-тестами (vitest импортирует CJS напрямую).
 *
 * Модель: узлы графа — OSM-узлы, где сходятся ≥2 дороги, плюс концы дорог.
 * Ребро — сегмент way между соседними узлами графа с длиной по гаверсинусу
 * и полилинией промежуточных точек (для отрисовки и map-matching).
 */

'use strict';

const EARTH_R = 6371000;

function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Классы highway, пригодные для подъезда к тропам (авто + пешком). */
const HIGHWAY_WHITELIST = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'service', 'living_street',
  'track', 'road', 'path', 'footway', 'bridleway', 'cycleway',
]);

/**
 * Строит граф из массива Overpass-элементов (way с tags и geometry).
 * @param {Array<{type:string,id:number,tags?:Record<string,string>,nodes?:number[],geometry?:Array<{lat:number,lon:number}>}>} elements
 * @returns {{nodes: Map<number,{lat:number,lng:number}>, edges: Array<{from:number,to:number,length_m:number,highway:string,surface:string|null,name:string|null,geometry:Array<[number,number]>}>}}
 */
function buildGraph(elements) {
  const ways = elements.filter(
    (e) => e.type === 'way'
      && e.tags && HIGHWAY_WHITELIST.has(e.tags.highway)
      && Array.isArray(e.nodes) && Array.isArray(e.geometry)
      && e.nodes.length === e.geometry.length
      && e.nodes.length >= 2,
  );

  // Сколько дорог проходит через каждый OSM-узел: ≥2 = перекрёсток
  const usage = new Map();
  for (const w of ways) {
    for (const nid of w.nodes) usage.set(nid, (usage.get(nid) || 0) + 1);
  }

  const nodes = new Map();
  const edges = [];

  for (const w of ways) {
    const highway = w.tags.highway;
    const surface = w.tags.surface || null;
    const name = w.tags.name || null;

    // Индексы точек way, являющихся узлами графа: концы + перекрёстки
    const cutIdx = [];
    for (let i = 0; i < w.nodes.length; i++) {
      const isEnd = i === 0 || i === w.nodes.length - 1;
      if (isEnd || (usage.get(w.nodes[i]) || 0) >= 2) cutIdx.push(i);
    }

    for (let c = 0; c + 1 < cutIdx.length; c++) {
      const a = cutIdx[c];
      const b = cutIdx[c + 1];
      const fromId = w.nodes[a];
      const toId = w.nodes[b];
      if (fromId === toId) continue; // вырожденная петля на одном узле

      let length = 0;
      const poly = [];
      for (let i = a; i <= b; i++) {
        const g = w.geometry[i];
        poly.push([g.lat, g.lon]);
        if (i > a) {
          const p = w.geometry[i - 1];
          length += haversineM(p.lat, p.lon, g.lat, g.lon);
        }
      }
      // Округляем ДО проверки: микросегмент 0.04 м проходил length>0,
      // но округлялся в 0.0 и валился на Zod positive() (run 1 импорта)
      const roundedLength = Math.round(length * 10) / 10;
      if (roundedLength <= 0) continue;

      const gA = w.geometry[a];
      const gB = w.geometry[b];
      nodes.set(fromId, { lat: gA.lat, lng: gA.lon });
      nodes.set(toId, { lat: gB.lat, lng: gB.lon });

      edges.push({
        from: fromId,
        to: toId,
        length_m: roundedLength,
        highway,
        surface,
        name,
        geometry: poly,
      });
    }
  }

  return { nodes, edges };
}

/** Режет массив на чанки по n элементов. */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

module.exports = { buildGraph, haversineM, chunk, HIGHWAY_WHITELIST };
