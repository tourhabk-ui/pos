-- 1423: поле «сайт» партнёра из его же контактов (11.11, владелец: «где сайт
-- http://fishingkam.ru/» — на экране проверки сайтов партнёров его нет).
--
-- Экран /hub/admin/operator-sites и ночная проверка сайтов
-- (/api/cron/operator-site-audit) берут адрес из partners.website. У
-- «Камчатской рыбалки» сайт записан миграциями 842 и 1106 только в контакты
-- (contacts.website, contact.website), колонка пуста — сайт не проверялся ни
-- разу и в список не попал.
--
-- Правило: пустая колонка заполняется адресом из контактов того же партнёра —
-- сначала contacts, затем contact. Только http(s), и не соцсети и мессенджеры:
-- их страница — не сайт партнёра, проверять её незачем. Заполненную колонку
-- не трогаем. Идемпотентно: второй прогон ничего не меняет.

-- Адрес из контактов один и тот же выражением в SET и в WHERE: одна таблица,
-- без самосоединения.
UPDATE partners
   SET website    = btrim(COALESCE(
         CASE WHEN jsonb_typeof(contacts) = 'object' THEN NULLIF(btrim(contacts->>'website'), '') END,
         CASE WHEN jsonb_typeof(contact)  = 'object' THEN NULLIF(btrim(contact->>'website'), '') END
       )),
       updated_at = NOW()
 WHERE (website IS NULL OR btrim(website) = '')
   AND btrim(COALESCE(
         CASE WHEN jsonb_typeof(contacts) = 'object' THEN NULLIF(btrim(contacts->>'website'), '') END,
         CASE WHEN jsonb_typeof(contact)  = 'object' THEN NULLIF(btrim(contact->>'website'), '') END
       )) ~* '^https?://[a-z0-9а-яё.-]+\.[a-zа-яё]{2,}(/|$)'
   AND btrim(COALESCE(
         CASE WHEN jsonb_typeof(contacts) = 'object' THEN NULLIF(btrim(contacts->>'website'), '') END,
         CASE WHEN jsonb_typeof(contact)  = 'object' THEN NULLIF(btrim(contact->>'website'), '') END
       )) !~* '^https?://([a-z0-9-]+\.)*(vk\.com|vk\.ru|t\.me|telegram\.me|instagram\.com|ok\.ru|wa\.me|whatsapp\.com|youtube\.com|youtu\.be|tiktok\.com|max\.ru|dzen\.ru|facebook\.com)(/|$)';
