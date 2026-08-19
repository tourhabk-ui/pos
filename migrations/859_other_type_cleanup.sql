-- Migration 859: разбор «прочего» — закопанные достопримечательности и не-места
-- Created: 2026-08-14
--
-- Седьмая серия чистки типов. Тип other — 60 записей (проба 95, полный срез
-- после починки канала чтения) — оказался двумя кучами:
--
-- 1. НАСТОЯЩИЕ МЕСТА с потерянным типом. Кутхины баты (знаменитые пемзовые
--    столбы у Курильского озера), Ганальские востряки, Парящая долина,
--    Семячикский лиман, лагуна Тинтикун, гейзер Царь-бомба, три видовки —
--    в срезах по видам они не участвовали и в подборках не показывались,
--    потому что лежали в «прочем».
--
-- 2. НЕ-МЕСТА, видимые в каталоге. Эссе («Камчатка», «Камчатка в моем
--    сердце»), лозунги («Страна рыбы и рыбоедов», «Камчатка. Рискни
--    покорить!»), справки без объекта («пещеры», «виды на  косяки рыб»),
--    впечатление («Вертолёт») и коммерческое судно (Яхта «Wild»). Карточка
--    места по CLAUDE.md §9 — географический факт; эссе фактом не является.
--    Скрытие мягкое и обратимое (is_visible), записи не удаляются и не
--    сливаются — сливать эссе в вулкан было бы искажением истории правок.
--
-- Правила прежние: прицел по id И текущему типу (для скрытий — И по имени,
-- И по текущей видимости); координаты не трогаются (у Царь-бомбы и Японского
-- моста они под подозрением — ждут эталона, тип честен уже сейчас).

-- ── Долины ──────────────────────────────────────────────────────────────────
UPDATE places SET location_type = 'valley'
 WHERE id = '075f0e9c-a833-4fa3-b481-545a2b177c14' AND location_type = 'other';

UPDATE places SET location_type = 'valley'
 WHERE id = 'bf9f9464-7a31-4351-b654-7ca278e5401f' AND location_type = 'other';

UPDATE places SET location_type = 'valley'
 WHERE id = 'f4545c9b-e701-4305-86fc-ab0d7c318afc' AND location_type = 'other';

UPDATE places SET location_type = 'valley'
 WHERE id = 'af903540-86b1-4e73-b36f-31ca926fc6e0' AND location_type = 'other';

UPDATE places SET location_type = 'valley'
 WHERE id = '852465ed-60f2-4db7-9715-6e3e8018af1f' AND location_type = 'other';

-- ── Скалы и камни ───────────────────────────────────────────────────────────
UPDATE places SET location_type = 'rock'
 WHERE id = '7adea817-0392-4c41-97a8-7693c7141310' AND location_type = 'other';

UPDATE places SET location_type = 'rock'
 WHERE id = '663e37f3-5deb-4907-ac25-321dd247d85e' AND location_type = 'other';

UPDATE places SET location_type = 'rock'
 WHERE id = 'ffb8cc6d-407a-4186-9635-1baddcc87de1' AND location_type = 'other';

UPDATE places SET location_type = 'rock'
 WHERE id = '8f8fa666-fbe0-489d-ae79-8655c83d3b20' AND location_type = 'other';

UPDATE places SET location_type = 'rock'
 WHERE id = 'ac4aff46-e142-4e03-8ed9-9ea01279fcbb' AND location_type = 'other';

UPDATE places SET location_type = 'rock'
 WHERE id = 'dac787de-8f88-4ae1-8711-27b44382139b' AND location_type = 'other';

UPDATE places SET location_type = 'rock'
 WHERE id = '0f72db3e-4ff2-4d46-b9cd-2e63348a61a3' AND location_type = 'other';

-- ── Горы ────────────────────────────────────────────────────────────────────
UPDATE places SET location_type = 'mountain'
 WHERE id = 'b3ee62b9-e760-4fda-9254-8f8ddbd9c33a' AND location_type = 'other';

UPDATE places SET location_type = 'mountain'
 WHERE id = 'e0a8e65f-5b72-4083-aabf-bbea7cfd3c3f' AND location_type = 'other';

-- ── Смотровые ───────────────────────────────────────────────────────────────
UPDATE places SET location_type = 'viewpoint'
 WHERE id = 'c6df4d42-504c-4149-ae46-417f9e1ae33e' AND location_type = 'other';

UPDATE places SET location_type = 'viewpoint'
 WHERE id = '94220a7c-c4bb-4b16-8147-430b5e770617' AND location_type = 'other';

UPDATE places SET location_type = 'viewpoint'
 WHERE id = '00f39b3d-e12f-4482-9e2c-58063b8edd49' AND location_type = 'other';

-- ── Вода и берега ───────────────────────────────────────────────────────────
UPDATE places SET location_type = 'lake'
 WHERE id = '3aa40826-5dac-4a8d-9376-0b3ae9c48c1e' AND location_type = 'other';

UPDATE places SET location_type = 'bay'
 WHERE id = '5d607216-cd91-4c15-bb50-f8f01bb8a266' AND location_type = 'other';

UPDATE places SET location_type = 'bay'
 WHERE id = '09122655-19ba-4160-a05c-eb71448833e3' AND location_type = 'other';

UPDATE places SET location_type = 'bay'
 WHERE id = '3ad4160b-c9cd-449d-a59f-03b65b5daaa3' AND location_type = 'other';

-- ── Термальное ──────────────────────────────────────────────────────────────
UPDATE places SET location_type = 'geyser'
 WHERE id = '8ed1a743-ddb9-4180-9ab9-d0f99fa5f058' AND location_type = 'other';

UPDATE places SET location_type = 'hot_spring'
 WHERE id = '2e901504-903a-409b-af60-dfa458ec8d79' AND location_type = 'other';

-- ── Историческое ────────────────────────────────────────────────────────────
UPDATE places SET location_type = 'historical'
 WHERE id = '583c8f78-d82d-4021-8b59-84c8616065b0' AND location_type = 'other';

UPDATE places SET location_type = 'historical'
 WHERE id = '3628b142-729d-4089-97c2-8ef7309fdac6' AND location_type = 'other';

-- ── Не-места: скрыть из каталога (мягко, обратимо) ──────────────────────────
UPDATE places SET is_visible = false
 WHERE id = '607e3dae-c85c-486a-a1a4-4790aaebfcc0'
   AND name = 'Камчатка' AND is_visible = true;

UPDATE places SET is_visible = false
 WHERE id = 'a98bc58d-1baa-4a5c-b2a9-ff44828ffb5f'
   AND name = 'Камчатка в моем сердце' AND is_visible = true;

UPDATE places SET is_visible = false
 WHERE id = 'e16e28ed-7fa9-42b7-bdcf-c8bd7687dcfb'
   AND name = 'Камчатка. Рискни покорить!' AND is_visible = true;

UPDATE places SET is_visible = false
 WHERE id = 'e873a54e-40d9-4040-9f7e-8f21d92c2b4a'
   AND name = 'Страна рыбы и рыбоедов' AND is_visible = true;

UPDATE places SET is_visible = false
 WHERE id = '0d9e53bd-4add-4cf0-a35a-f8ecd942bf03'
   AND name = 'пещеры' AND is_visible = true;

UPDATE places SET is_visible = false
 WHERE id = '963a971d-5022-4563-862c-76063fafdf9b'
   AND name = 'Вертолёт' AND is_visible = true;

UPDATE places SET is_visible = false
 WHERE id = 'd1a48b21-1b44-4775-a039-3d2f97fcb388'
   AND name = 'виды на  косяки рыб' AND is_visible = true;

UPDATE places SET is_visible = false
 WHERE id = '00c1a162-bfce-4649-9b77-f38f647392c0'
   AND name = 'Яхта "Wild"' AND is_visible = true;
