-- 841: Поправка телефонов «Камчатской рыбалки» + личный Telegram.
--
-- Источник: владелец, 08.08.2026, вторым сообщением: «+79247808011,
-- +79147822222 эти телефоны у рыбалки. ТГ @labanalex». Номер +79992997007
-- из миграции 840 оказался неверным — заменяем; второй номер совпал.
-- telegram_contact — ЛИЧНЫЙ чат для связи (кнопка «Написать в Telegram»),
-- в отличие от канала с уловами (ключ канала записан миграцией 834).
--
-- Идемпотентно: guard по IS DISTINCT FROM, повторный прогон — no-op.

UPDATE partners
   SET contacts = COALESCE(contacts, '{}'::jsonb) || jsonb_build_object(
         'phone',  '+79247808011',
         'phone2', '+79147822222',
         'telegram_contact', 'labanalex'
       ),
       updated_at = NOW()
 WHERE name ILIKE '%камчатская рыбалка%'
   AND (contacts->>'phone'  IS DISTINCT FROM '+79247808011'
     OR contacts->>'phone2' IS DISTINCT FROM '+79147822222'
     OR contacts->>'telegram_contact' IS DISTINCT FROM 'labanalex');
