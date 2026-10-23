-- 1323: карточка туроператора «Лагуна Экспедиция» (laguna-expedition.ru) —
-- пока без туров.
--
-- Основание. Владелец 23.10: «Сделай еще лагуна экспедиция и телефон такой
-- же» — вслед за «Лагуной Прокат» (1318) того же круга (СПА-отель «Лагуна»,
-- docs/partners/blue-lagoon-call.md). «Телефон такой же» — номер карточки
-- «Лагуны Прокат»: он копируется из её строки здесь же, в SQL, и нового
-- номера в репозитории нет.
--
-- Владелец назвал и контактное лицо — полным именем. В эту миграцию оно не
-- пишется: репозиторий открытый, а полное имя частного человека — его
-- персональные данные (то же правило, что у 1174, 1216 и 1234: имён людей в
-- карточке нет). Аккаунт на это имя заводит владелец из админки («Завести
-- аккаунт»), там имя и живёт.
--
-- ── Источник остальных полей ──────────────────────────────────────────────
-- Сайт оператора laguna-expedition.ru, снятый 23.10.2026: меню и подвал
-- главной. Юрлицо ООО «Экспедиция», ИНН 9717173941, ОГРН 1247700802546,
-- регистрационный номер туроператора В031-00161-77/01703236 — из подвала (те
-- же реквизиты записаны в docs/partners/blue-lagoon-call.md, «Что сверено
-- 23.10»). С ЕГРЮЛ и реестром туроператоров не сверялись: `registry_status`
-- не трогается, отметки «в реестре» страница не рисует. Telegram t.me/
-- laguna_expedition — канал («Камчатка | туры и экскурсии»), поэтому
-- `telegram_channel`; MAX — ссылка с сайта оператора. Город и адрес офиса на
-- сайте не названы — в `location` только край. Описание пересказывает меню
-- сайта: многодневные туры (осенние, зимние, Новый год и каникулы),
-- однодневные экскурсии (вездеход Sever Truck, внедорожники Tank-300,
-- вертолётные, за снегоходом, этнические программы), трансферы; проживание в
-- СПА-отеле «Лагуна» — у части туров, как на сайте. Цен нет: туров на Ведаре
-- нет, а цены сайта сезонные.
--
-- Номер 8 800 с сайта в карточку не взят: владелец назвал телефон сам.
--
-- ── Чего в карточке НЕТ, и это намеренно ──────────────────────────────────
--   • Туров — их заводят отдельно (с сайта или кабинетом оператора).
--   • Имён людей и личного аккаунта (`user_id` пуст) — см. выше.
--   • Отметки «проверено» (`is_verified`) — её ставит администратор.
--   • Логотипа и снимков — согласия на материалы нет (1321).
--   • Ставки комиссии — оплата через платформу выключена (05.10); колонка не
--     задаётся.
--
-- Видна сразу (`is_public`), как «Лагуна Прокат»: владелец ведёт разговор с
-- группой «Лагуна» и сам велел завести карточку. В списке компаний /operators
-- она стоит по алфавиту с честным «туров пока нет».
--
-- IDEMPOTENT. Повтор по slug, названию или ИНН ничего не добавляет и правки
-- администратора не перетирает. Исход называется вслух в конце.

BEGIN;

INSERT INTO partners (
  slug, name, company_name, category,
  short_description, description,
  contact, contacts, location, website,
  legal_info, registry_number,
  rating, review_count, is_verified, is_public, created_at
)
SELECT
  'laguna-expedition',
  'Лагуна Экспедиция',
  'Лагуна Экспедиция',
  'operator',
  'Многодневные туры и однодневные экскурсии по Камчатке: вездеход Sever Truck, внедорожники Tank-300, вертолёт, снегоходы, этнические программы.',
  'Туры и экскурсии по Камчатке. Многодневные туры — осенние, зимние, на Новый год и каникулы; у части туров '
    || 'проживание в СПА-отеле «Лагуна». Однодневные экскурсии — на вездеходе Sever Truck и внедорожниках Tank-300, '
    || 'вертолётные, за снегоходом, этнические программы; есть трансферы. Ведар оплату не принимает: туристы платят '
    || 'оператору напрямую. Даты и цены называет оператор.',
  jsonb_strip_nulls(jsonb_build_object(
    'phone', (SELECT NULLIF(btrim(lp.contacts->>'phone'), '') FROM partners lp WHERE lp.slug = 'laguna-prokat' LIMIT 1)
  )),
  jsonb_strip_nulls(jsonb_build_object(
    'phone',            (SELECT NULLIF(btrim(lp.contacts->>'phone'), '') FROM partners lp WHERE lp.slug = 'laguna-prokat' LIMIT 1),
    'telegram_contact', (SELECT NULLIF(btrim(lp.contacts->>'telegram_contact'), '') FROM partners lp WHERE lp.slug = 'laguna-prokat' LIMIT 1),
    'telegram_channel', 'https://t.me/laguna_expedition',
    'max',              'https://max.ru/u/f9LHodD0cOIBFMRMpY4sXOKCAxf4FQ3LcSK3ygsCzQD8WWMt5CrCm0hkNWw',
    'website',          'https://laguna-expedition.ru'
  )),
  jsonb_build_object('region', 'Камчатский край'),
  'https://laguna-expedition.ru',
  jsonb_build_object(
    'companyName', 'ООО «Экспедиция»',
    'inn',         '9717173941',
    'ogrn',        '1247700802546'
  ),
  'РТО В031-00161-77/01703236',
  0, 0, FALSE, TRUE, NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM partners
   WHERE slug = 'laguna-expedition'
      OR lower(name) LIKE '%лагуна экспедиц%'
      OR legal_info->>'inn' = '9717173941'
);

-- Исход называется вслух: карточка одна, и телефон у неё тот же, что у «Лагуны Прокат».
DO $$
DECLARE
  v_n int;
  v_same int;
BEGIN
  SELECT count(*) INTO v_n FROM partners
   WHERE slug = 'laguna-expedition' OR legal_info->>'inn' = '9717173941';
  SELECT count(*) INTO v_same FROM partners e
    JOIN partners lp ON lp.slug = 'laguna-prokat'
   WHERE e.slug = 'laguna-expedition'
     AND e.contacts->>'phone' IS NOT DISTINCT FROM lp.contacts->>'phone';
  IF v_n <> 1 THEN
    RAISE WARNING '[1323] «Лагуна Экспедиция»: найдено % карточек по slug или ИНН (нужна ровно одна)', v_n;
  END IF;
  IF v_same <> 1 THEN
    RAISE WARNING '[1323] «Лагуна Экспедиция»: телефон не совпал с «Лагуной Прокат» (карточка могла быть заведена раньше)';
  END IF;
END $$;

COMMIT;
