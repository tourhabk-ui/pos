-- 866_reset_lying_descriptions.sql
--
-- Задание Editor-агенту: переписать описания, которые врут о месте.
--
-- Прочёс шести групп 15.08 (data/audit/content-mismatch-2026-08-15.md)
-- нашёл описания, противоречащие координатам записи: текст сгенерирован
-- когда-то от чужого контекста или от старого типа. Механизм постановки
-- задачи — канонический, тот же, что у санитара контента
-- (lib/agents/evo/content-sanitizer.ts): «откат = NULL описания → Editor
-- регенерирует чисто», NULL-описания идут в приоритете его очереди
-- (ORDER BY description IS NULL DESC), а промпт Editor'а прямо разрешает
-- честный короткий ответ вместо выдумки.
--
-- Каждый NULL защищён СИГНАТУРОЙ вранья: описание сбрасывается только
-- пока содержит ложную фразу. Это даёт идемпотентность и защиту от
-- перетирания: текст, уже переписанный Editor'ом (или админом), сигнатуру
-- не содержит и не тронется.
--
-- «Японский мост» в задание НЕ входит сознательно: там неизвестно, что
-- битое — текст или координата. Если правдив текст (Елизовский район),
-- сброс уничтожил бы правду. Остаётся в докладе до выяснения координаты.
-- «Скала Чёрный замок» входит: числа в тексте расходятся с записью на
-- 9 км, а выдуманные числа хуже текста без чисел.

UPDATE places SET description = NULL, updated_at = NOW()
 WHERE name = 'Перевал Малыш' AND merged_into_id IS NULL
   AND description LIKE '%Ключевск%';   -- точка в Налычево, до Ключевского 280 км

UPDATE places SET description = NULL, updated_at = NOW()
 WHERE name = 'Царь-бомба' AND merged_into_id IS NULL
   AND description LIKE '%гейзер%';     -- это бомба БТТИ у Толбачика, тип уже rock (865)

UPDATE places SET description = NULL, updated_at = NOW()
 WHERE name = 'Камень Амбон' AND merged_into_id IS NULL
   AND description LIKE '%от Петропавловска%';  -- по факту ~450 км, не сорок

UPDATE places SET description = NULL, updated_at = NOW()
 WHERE name = 'Каменный городок' AND merged_into_id IS NULL
   AND description LIKE '%Паратунк%';   -- точка на юге у Паужетки, Паратунка в 160 км

UPDATE places SET description = NULL, updated_at = NOW()
 WHERE name = 'Скала Черный замок' AND merged_into_id IS NULL
   AND description LIKE '%55.92%';      -- числа в тексте расходятся с записью на 9 км

INSERT INTO _migrations (name)
VALUES ('866_reset_lying_descriptions.sql')
ON CONFLICT (name) DO NOTHING;
