-- 847: Единый источник геометрии маршрута.
--
-- Слово владельца: перенести все маршруты в единую базу, «как у мап.ми».
-- У Organic Maps единая база — это не одно хранилище, а ОДИН ИСТОЧНИК
-- ИСТИНЫ: карта, маршрут, поиск и высоты приходят из одного .mwm, и
-- разойтись между собой не могут в принципе.
--
-- У нас источников два, и они независимы:
--   линия  — kamchatka_routes.geometry (у части маршрутов ещё и payload);
--   точки  — route_waypoints -> places.
--
-- Отсюда полевой скриншот 11.08: «Мыс Маячный» стоит на южном берегу входа
-- в Авачинскую бухту, трек идёт по северному, между ними вода — а экран
-- уверенно считал «20.3 км» и «придём через 5 ч 45 м». Заплатка снимает
-- цифру, но причина в данных: два независимых источника об одном маршруте.
--
-- Эта таблица делает линию геометрией ЗАПИСИ: одна на маршрут, с явным
-- происхождением и достоверностью. А положение путевой точки перестаёт быть
-- независимой координатой и становится СВОЙСТВОМ этой линии — along_m вдоль
-- неё и offset_m в сторону от неё. Разойтись двум числам об одном маршруте
-- после этого не с чем: они считаются из одного и того же.
--
-- NULL против нуля здесь принципиален и назван явно:
--   offset_m IS NULL  — не считали (нет линии, нет координат у точки);
--   offset_m = 0      — посчитали, точка лежит НА линии.
-- Ноль вместо «неизвестно» — ровно тот дефект, из-за которого якорь
-- маршрута без координат оказывался в Гвинейском заливе.

CREATE TABLE IF NOT EXISTS route_geometry (
  route_id UUID PRIMARY KEY,
  -- GeoJSON LineString, [lng, lat, ele?] — тот же вид, что читает вся
  -- платформа (lib/routes/track.ts). Своего диалекта не заводим.
  geometry JSONB NOT NULL,
  -- Откуда взялась линия: 'geometry' (kamchatka_routes.geometry),
  -- 'payload' (legacy JSONB ранних импортов), 'waypoints' (построена
  -- прямыми между путевыми точками — идти по ней нельзя).
  source VARCHAR(16) NOT NULL,
  -- 'surveyed' | 'sketch' | 'unknown' — по тому же правилу, что рисует
  -- линию на экране (lib/routes/track-fidelity), а не по своему порогу.
  fidelity VARCHAR(16) NOT NULL,
  points INT NOT NULL,
  length_m REAL NOT NULL,
  -- Худший отрыв путевой точки от собственной линии, метры.
  -- NULL — точек маршрута нет, сверять не с чем.
  worst_offset_m REAL,
  -- По чему построено. Не совпало со входом — пересобрать; совпало —
  -- сборка не трогает строку и не двигает built_at.
  input_fingerprint TEXT NOT NULL,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_geometry_fidelity ON route_geometry (fidelity);
CREATE INDEX IF NOT EXISTS idx_route_geometry_source   ON route_geometry (source);

-- Положение точки НА линии записи, а не рядом с ней.
ALTER TABLE route_waypoints ADD COLUMN IF NOT EXISTS along_m  REAL;
ALTER TABLE route_waypoints ADD COLUMN IF NOT EXISTS offset_m REAL;

COMMENT ON COLUMN route_waypoints.along_m  IS
  'Метры вдоль геометрии записи до проекции точки. NULL — не считали.';
COMMENT ON COLUMN route_waypoints.offset_m IS
  'Метры от геометрии записи до точки. NULL — не считали, 0 — точка на линии.';
