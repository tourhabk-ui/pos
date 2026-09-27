-- 1035: база отдыха «Голубая лагуна» (озеро Микижа) — в список будущих партнёров.
--
-- 26.09 владелец, разбирая карточку озера Микижа: «на берегу база отдыха
-- Голубая лагуна» и ссылка на сайт bluelagoon.su. Витрина жилья на этот день
-- пуста (MCP search_accommodations: «ни одного предложения»), а объявление
-- жилья заводит сам владелец базы через регистрацию в роли stay —
-- администратор его только одобряет. Значит первое, что можно сделать с
-- нашей стороны, — записать базу туда, откуда её возьмут в работу:
-- `partner_prospects` (миграция 816), статус 'new'.
--
-- Записано только проверяемое, и у каждого факта назван источник:
--   - имя, сайт, берег озера — слово владельца;
--   - причал с лодками и водными велосипедами, бассейн — его снимки;
--   - система бронирования и контакты для броней — разбор сайта, который
--     владелец прислал тем же вечером: онлайн-бронь идёт через TravelLine
--     (виджет ru-ibe.tlintegration.ru, код объекта 5194, профиль
--     TL-INT-bluelagoon-new), сайт на Tilda, объект продаётся и через OTA.
-- Цен и условий здесь нет: их никто не называл, а по памяти не пишутся (§4.0).
--
-- Почему система бронирования записана отдельным полем: от неё зависит путь
-- на витрину. У TravelLine номерной фонд и календарь ведутся в их системе, и
-- ручное объявление у нас разошлось бы с ним в первый же день. Решение —
-- вести объявление руками или подключать TravelLine — за владельцем.
--
-- Повтор не плодит строк: уникальный индекс по LOWER(name).
--
-- Идемпотентна.

INSERT INTO partner_prospects (name, source, website, details, notes, status)
VALUES (
  'Голубая лагуна',
  'Слово владельца платформы 26.09.2026 при разборе карточки «Озеро Микижа»; разбор сайта прислал владелец тем же вечером',
  'https://bluelagoon.su/',
  jsonb_build_object(
    'kind', 'accommodation',
    'aka', 'СПА-отель «Лагуна», Паратунка',
    'place', 'Озеро Микижа',
    'place_coords', jsonb_build_array(53.01045, 158.26904),
    'seen_on_owner_photos', jsonb_build_array('причал с лодками и водными велосипедами', 'бассейн'),
    'booking_system', jsonb_build_object(
      'vendor', 'TravelLine',
      'provider_id', '5194',
      'integration_profile', 'TL-INT-bluelagoon-new',
      'widget_host', 'ru-ibe.tlintegration.ru',
      'booking_url', 'https://bluelagoon.su/booking',
      'sells_via_ota', true
    ),
    'booking_contacts', jsonb_build_object(
      'email', 'booking@bluelagoon.su',
      'phone', '8 800 222-58-03'
    ),
    'site_platform', 'Tilda'
  ),
  'СПА-отель на берегу озера Микижа (Паратунка). Номера и календарь ведутся в TravelLine (объект 5194), продаётся и через агрегаторы. Путь на витрину — либо объявление руками через роль «жильё» (разойдётся с их календарём), либо подключение к TravelLine как канал продаж; решение за владельцем платформы.',
  'new'
)
ON CONFLICT (LOWER(name)) DO UPDATE
   SET source  = EXCLUDED.source,
       website = EXCLUDED.website,
       details = partner_prospects.details || EXCLUDED.details,
       notes   = EXCLUDED.notes,
       updated_at = NOW()
 WHERE partner_prospects.status = 'new';
