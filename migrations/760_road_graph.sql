-- 760: Дорожный граф Камчатки из OSM — фундамент своего роутера (A*).
-- Решение владельца 2026-07-20: планирование маршрута «от меня до старта
-- тропы» строим сами по OSM-дорогам, без внешних роутинг-API (офлайн-first).
--
-- Заполняется импортом: раннер GitHub Actions качает дороги с Overpass
-- (с Timeweb OSM недоступен), строит граф и заливает чанками через
-- POST /api/admin/import/road-graph (CRON_SECRET).
--
-- Узлы = перекрёстки и концы дорог (OSM node id).
-- Рёбра = сегменты дорог между узлами, двунаправленные (oneway — позже),
-- geometry — полилиния сегмента [[lat,lng],...] для отрисовки и map-matching.

CREATE TABLE IF NOT EXISTS road_graph_nodes (
  id BIGINT PRIMARY KEY,          -- OSM node id
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS road_graph_edges (
  id BIGSERIAL PRIMARY KEY,
  from_node BIGINT NOT NULL,
  to_node BIGINT NOT NULL,
  length_m REAL NOT NULL,
  highway VARCHAR(32) NOT NULL,   -- OSM highway class: primary, track, path...
  surface VARCHAR(32),            -- asphalt, gravel, ground... (NULL = неизвестно)
  name TEXT,
  geometry JSONB                  -- [[lat,lng],...] полилиния сегмента
);

-- Поиск рёбер из узла — ядро A*
CREATE INDEX IF NOT EXISTS idx_road_edges_from ON road_graph_edges (from_node);
CREATE INDEX IF NOT EXISTS idx_road_edges_to   ON road_graph_edges (to_node);
-- bbox-выборка подграфа вокруг старта/финиша
CREATE INDEX IF NOT EXISTS idx_road_nodes_lat ON road_graph_nodes (lat);
CREATE INDEX IF NOT EXISTS idx_road_nodes_lng ON road_graph_nodes (lng);

-- Метаданные импортов: видно, когда и чем граф наполнен
CREATE TABLE IF NOT EXISTS road_graph_imports (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  nodes_count INT NOT NULL DEFAULT 0,
  edges_count INT NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'overpass',
  note TEXT
);
