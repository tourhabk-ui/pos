-- 1103: «Камчатская рыбалка» — сайт партнёра в белый список виджета,
--       контакты после ухода Александра.
--
-- Владелец 29.09: партнёр дал полный доступ к своему сайту (fishingkam.ru,
-- Tilda), решение — поставить туда чат Кузьмича и форму заявки Ведара.
-- Виджет у партнёра включён с 863, но `widget_domains` пуст: CORS в
-- /api/widget/chat и /api/widget/lead.js сверяет Origin с этим списком, и с
-- fishingkam.ru ни чат, ни форма не прошли бы. Проверка — по хосту и его
-- поддоменам, поэтому одной записи хватает и на www.
--
-- Контакты — со слов владельца 29.09 по сообщению партнёра: «Александра
-- удали, он уволился», «номер +7 924 780-80-11 убери». Остаётся Анатолий
-- (+7 914 782-22-22, записан 841 как phone2) — он становится основным
-- телефоном. Личный Telegram labanalex (841) — Александра, уходит вместе с
-- ним; канал t.me/KamFishing_41 (834) — канал базы, остаётся.
--
-- Гейт по id (из 863), каждая часть идемпотентна.

-- 1. Домен сайта в белый список виджета; slug только заполняется, если пуст.
UPDATE partners
   SET widget_domains = array_append(COALESCE(widget_domains, '{}'), 'fishingkam.ru'),
       widget_enabled = true,
       slug = COALESCE(slug, 'fishingkam'),
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND NOT ('fishingkam.ru' = ANY (COALESCE(widget_domains, '{}')));

-- 2. Контакты: Александр убран, Анатолий — основной телефон.
UPDATE partners
   SET contacts = (COALESCE(contacts, '{}'::jsonb) - 'telegram_contact' - 'phone2')
                  || jsonb_build_object('phone', '+79147822222'),
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND (contacts->>'phone' IS DISTINCT FROM '+79147822222'
     OR contacts ? 'phone2'
     OR contacts ? 'telegram_contact');

-- 3. Имя администратора, если оно записано как Александр (ключи из
--    profile-parse: admin_name / admin_name_2) — снять; выдумывать имя на
--    замену нельзя, пустое честнее.
UPDATE partners
   SET contacts = contacts - 'admin_name',
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND contacts->>'admin_name' ILIKE 'Александр%';

UPDATE partners
   SET contacts = contacts - 'admin_name_2',
       updated_at = NOW()
 WHERE id = '0aaa4f05-b479-418b-9d54-2b909783dfd7'
   AND contacts->>'admin_name_2' ILIKE 'Александр%';
