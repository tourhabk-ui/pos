-- 763: Очистить описания, в которые попал сырой Verbalized Sampling JSON.
--
-- Баг (проявился на «Озеро Большой Калыгирь», /routes/1dd78671-…): Editor и
-- places-enricher применяют Verbalized Sampling — просят у модели JSON-массив
-- [{"probability":…,"text":"…"}] и выбирают лучший text. Когда fast-провайдер
-- обрезал ответ по лимиту токенов, JSON.parse всего массива падал,
-- parseVerbalizedSamples возвращал [], а fallback `picked ?? raw` сохранял
-- СЫРОЙ обрезанный массив как описание. Турист видел JSON вместо текста.
--
-- Код починен в этом же PR (salvage завершённых объектов + guard: сырой
-- VS-JSON больше не сохраняется, это провал генерации). Здесь — ремонт уже
-- испорченных строк: NULL-им их, чтобы Editor/enricher перегенерировали
-- нормально (их выборка ловит description IS NULL). Пусто до перегенерации
-- лучше, чем JSON-мусор; карточка маршрута корректно рендерит пустое описание.
--
-- Пишем в master-таблицы напрямую (§4.1), не в VIEW agent_route_knowledge.
-- Сигнатура точная: реальная проза не начинается с '[' и не несёт
-- "probability"+"text". Идемпотентно: повторный прогон не найдёт строк.

UPDATE kamchatka_routes
SET description = NULL
WHERE description IS NOT NULL
  AND description ~ '^\s*\['
  AND description LIKE '%"probability"%'
  AND description LIKE '%"text"%';

UPDATE places
SET description = NULL
WHERE description IS NOT NULL
  AND description ~ '^\s*\['
  AND description LIKE '%"probability"%'
  AND description LIKE '%"text"%';
