-- Migration 815: настоящая цена оператора и его имя в чате
--
-- Владелец на живой карточке (05.08):
--   1. «от 10 000 ₽» — у оператора цена 13 000 ₽. Цена на карточке не
--      совпадает с ценой продавца: для коммерческого продукта это не опечатка,
--      а обещание, которого никто не выполнит.
--   2. Кнопка «Написать» открывает диалог с «Рога и Копыта».
--
-- Про имя. Миграция 810 перепривязала ТУР к реальному партнёру
-- (operator_tours.operator_id → partners.slug = 'kamchatka-rafting'), и на
-- карточке имя стало правильным. Но чат берёт имя собеседника не из partners, а
-- из users: `other_p.name` в lib/services/operators/chat.service.ts. Аккаунт,
-- на котором висит партнёр, так и остался с демо-именем — партнёра починили,
-- пользователя за ним нет. Классическая недоделка: исправили одно из двух мест,
-- где живёт одно и то же имя.
--
-- Правим ровно тот аккаунт, который стоит за реальным партнёром, и только пока
-- он носит демо-имя: чужие демо-записи не трогаем, их туры и так скрыты (807).
--
-- Матч по содержанию, без INSERT (partners старше системы миграций — INSERT в
-- неё уронил 806 и стоил трёх дней). Идемпотентна.

-- ── 1. Цена ───────────────────────────────────────────────────────────────────
WITH canonical AS (
  SELECT ot.id
    FROM operator_tours ot
   WHERE ot.deleted_at IS NULL
     AND ot.title ILIKE '%быстр%'
     AND (ot.title ILIKE '%сплав%' OR ot.activity_type IN ('rafting', 'boat_trip'))
   ORDER BY
     CASE WHEN ot.title = 'Сплав по реке Быстрая' THEN 0 ELSE 1 END,
     ot.created_at ASC
   LIMIT 1
)
UPDATE operator_tours ot
   SET base_price = 13000,
       price_unit = COALESCE(ot.price_unit, 'per_person'),
       updated_at = NOW()
  FROM canonical c
 WHERE ot.id = c.id
   AND ot.base_price IS DISTINCT FROM 13000;

-- ── 2. Имя оператора в чате ───────────────────────────────────────────────────
UPDATE users u
   SET name = 'Камчатка Рафтинг',
       updated_at = NOW()
  FROM partners p
 WHERE p.slug = 'kamchatka-rafting'
   AND u.id = p.user_id
   AND u.name ILIKE '%рога%копыт%';
