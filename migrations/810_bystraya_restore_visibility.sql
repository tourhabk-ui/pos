-- Migration 810: вернуть тур «Сплав по реке Быстрая» в витрину (был 404)
--
-- Симптом: /catalog/tours/27 отдаёт 404 «Тур не найден». Страница читает тур
-- условием is_active = true AND deleted_at IS NULL — значит тур скрыт.
--
-- Как он мог скрыться: 807 прячет туры, чей оператор НЕ один из двух реальных
-- партнёров. Тур 27 висел на демо-операторе «Рога и Копыта»; перепривязать его
-- к «Камчатка Рафтинг» должна была 806 — но если 806 упала целиком, 807
-- отработала по старому оператору и погасила тур.
--
-- Почему 806 могла упасть: она делает INSERT INTO partners. Таблица partners
-- создана ДО системы миграций, её NOT NULL-колонок в репозитории нет — любая
-- обязательная колонка без дефолта роняет весь файл (и 806 записывается в
-- _migration_failures, а тур остаётся скрытым).
--
-- Поэтому 810 НЕ ВСТАВЛЯЕТ НИЧЕГО. Только UPDATE по существующим строкам:
--   1. перепривязать тур к партнёру-рафтингу, если он есть;
--   2. если такого партнёра нет — переименовать текущего владельца тура
--      (демо-заглушку) в «Камчатка Рафтинг» с реальными контактами;
--   3. БЕЗУСЛОВНО вернуть тур в витрину.
--
-- Порядок шагов важен: 3 выполняется всегда, чтобы 404 не мог остаться даже
-- если 1 и 2 ничего не нашли. Идемпотентна.

-- 1. Перепривязать к настоящему партнёру-рафтингу, если он существует.
UPDATE operator_tours ot
   SET operator_id = p.id,
       updated_at  = NOW()
  FROM partners p
 WHERE p.slug = 'kamchatka-rafting'
   AND ot.title ILIKE '%быстр%'
   AND (ot.title ILIKE '%сплав%' OR ot.activity_type = 'rafting')
   AND ot.operator_id IS DISTINCT FROM p.id;

-- 2. Запасной путь: партнёра-рафтинга нет вовсе, а тур висит на демо-заглушке.
--    Переименовываем саму заглушку — без INSERT, без смены внешних ключей.
UPDATE partners p
   SET name     = 'Камчатка Рафтинг',
       slug     = 'kamchatka-rafting',
       contacts = COALESCE(p.contacts, '{}'::jsonb) || jsonb_build_object(
                    'phone', '+79247990191',
                    'admin_name', 'Катерина',
                    'admin_name_2', 'Ярослав',
                    'telegram_channel', 'https://t.me/+GCy5EVOotCE1NDMy'
                  )
 WHERE NOT EXISTS (SELECT 1 FROM partners x WHERE x.slug = 'kamchatka-rafting')
   AND p.id IN (
     SELECT ot.operator_id
       FROM operator_tours ot
      WHERE ot.title ILIKE '%быстр%'
        AND (ot.title ILIKE '%сплав%' OR ot.activity_type = 'rafting')
   );

-- 3. Безусловно вернуть в витрину ОДИН канонический тур — именно этого не
--    хватало для 404. Строго один: снимать deleted_at со всех подходящих нельзя,
--    иначе воскреснет дубль, который погасили 803/806.
--    Канонический = точное имя «Сплав по реке Быстрая», иначе самый старый живой,
--    иначе (все погашены) самый старый вообще — чтобы витрина не осталась пустой.
WITH canonical AS (
  SELECT ot.id
    FROM operator_tours ot
   WHERE ot.title ILIKE '%быстр%'
     AND (ot.title ILIKE '%сплав%' OR ot.activity_type IN ('rafting', 'boat_trip'))
   ORDER BY
     CASE WHEN ot.title = 'Сплав по реке Быстрая' THEN 0 ELSE 1 END,
     CASE WHEN ot.deleted_at IS NULL THEN 0 ELSE 1 END,
     ot.created_at ASC
   LIMIT 1
)
UPDATE operator_tours ot
   SET is_active    = TRUE,
       is_published = TRUE,
       deleted_at   = NULL,
       activity_type = 'rafting',
       updated_at   = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND (ot.is_active IS DISTINCT FROM TRUE
        OR ot.is_published IS DISTINCT FROM TRUE
        OR ot.deleted_at IS NOT NULL
        OR ot.activity_type IS DISTINCT FROM 'rafting');
