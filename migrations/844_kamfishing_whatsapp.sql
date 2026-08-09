-- 844: WhatsApp «Камчатской рыбалки» на карточке тура.
--
-- Источник номера — владелец, 09.08.2026: «whatsApp номер толика на 2222,
-- +79147822222» (Анатолий). Ссылка wa.me со старым номером 999… на сайте партнёра устарела — как и звонильный номер 999, заменённый в 841.
-- Храним в E.164 с плюсом, как телефоны.
--
-- Идемпотентно: guard по IS DISTINCT FROM.

UPDATE partners
   SET contacts = COALESCE(contacts, '{}'::jsonb) || jsonb_build_object(
         'whatsapp', '+79147822222'
       ),
       updated_at = NOW()
 WHERE name ILIKE '%камчатская рыбалка%'
   AND contacts->>'whatsapp' IS DISTINCT FROM '+79147822222';
