-- 1158: шаблон 070/0645 узнаётся по самой строке, а не по нынешнему типу места
-- Created: 2026-10-04
--
-- ── Повод ─────────────────────────────────────────────────────────────────
--
-- Снимок владельца 04.10, карточка термального источника: «Рельеф: forest ·
-- Сложность: ниже среднего · Лимит посещения: 50 человек в сутки ·
-- Опасности: дикие животные, резкая смена погоды». Это слово в слово ветка
-- ELSE шаблона 070 (50 / 8 / 2 / 'forest' / wildlife+weather) — её получали
-- все места без особого типа. Ни одно значение не измерено.
--
-- ── Почему 1100 это пропустила ───────────────────────────────────────────
--
-- 1100 сверяла строку с тем, что шаблон написал бы для ТЕКУЩЕГО типа места.
-- Но тип с тех пор правили (миграции 854, 857, 865 и др., сегодня — 1157):
-- место завели «прочим», шаблон дал ему лес и 50 человек, потом тип стал
-- «термальный источник». Сверка с шаблоном горячего источника (100 человек,
-- 'thermal') не сошлась, строка ушла в 'unknown' — и карточка стала печатать
-- лес у термального источника как факт.
--
-- ── Что делает ────────────────────────────────────────────────────────────
--
-- Строка с profile_source = 'unknown', у которой ВСЕ ПЯТЬ полей (лимит,
-- размер группы, сложность, рельеф, опасности) совпадают с выходом шаблона
-- 070 или 0645 для какой-либо пары «тип × активность», размечается как
-- 'type_template'. Список кортежей ниже — все выходы обоих вариантов шаблона,
-- перечисленные по их же CASE (6 типов × 4 активности × 2 варианта, без
-- повторов). Совпасть со всеми пятью полями чужого шаблона случайно ручная
-- запись не может; 'manual' не трогается вообще.
--
-- Карточка и Кузьмич прячут 'type_template' уже сейчас
-- (lib/safety/profile-source, honestSafetyFields): правило одно, новых
-- читателей не нужно.

BEGIN;

WITH template(cap, grp, diff, terrain, hazards) AS (
  VALUES
    (20, 4, 2, 'forest', ARRAY['wildlife','weather']::text[]),
    (20, 4, 2, 'water', ARRAY['water','rapids']::text[]),
    (20, 4, 2, 'water', ARRAY['wildlife','weather']::text[]),
    (30, 6, 4, 'mountain', ARRAY['avalanche','rockfall','thermal','altitude']::text[]),
    (50, 8, 2, 'forest', ARRAY['wildlife','weather']::text[]),
    (50, 8, 2, 'water', ARRAY['water','rapids']::text[]),
    (50, 8, 2, 'water', ARRAY['wildlife','weather']::text[]),
    (50, 8, 4, 'forest', ARRAY['wildlife','weather']::text[]),
    (50, 8, 4, 'water', ARRAY['water','rapids']::text[]),
    (50, 8, 4, 'water', ARRAY['wildlife','weather']::text[]),
    (80, 4, 2, 'forest', ARRAY['wildlife','weather']::text[]),
    (80, 8, 2, 'forest', ARRAY['wildlife','weather']::text[]),
    (80, 8, 4, 'forest', ARRAY['wildlife','weather']::text[]),
    (100, 4, 2, 'thermal', ARRAY['thermal','chemical']::text[]),
    (100, 8, 2, 'thermal', ARRAY['thermal','chemical']::text[]),
    (100, 8, 4, 'thermal', ARRAY['thermal','chemical']::text[])
)
UPDATE location_safety_profile lsp
   SET profile_source = 'type_template',
       profile_source_at = NOW()
  FROM template t
 WHERE lsp.profile_source = 'unknown'
   AND lsp.capacity_per_day = t.cap
   AND lsp.optimal_group_size = t.grp
   AND lsp.difficulty_level = t.diff
   AND lsp.terrain_type = t.terrain
   AND lsp.hazard_types = t.hazards;

COMMIT;
