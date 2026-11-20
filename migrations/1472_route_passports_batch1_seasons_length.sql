-- Migration 1472: сезон и длина 13 маршрутов по официальным паспортам
-- visitkamchatka.ru, партия 1 задачи #3568.
--
-- Сверка PDF глазами 21.11.2026 (01:18–01:25, Камчатка, UTC+12).
-- Ответ: tourhabk-ui/flo-claude answers/2026-11-20-passports-batch-1.md
-- (commit 2669a5b1445dc224f17c42da06f0f7f5f82aaf59).
-- В карточку идёт только то, что стоит в паспорте. Пустую протяжённость
-- (№9 Пиначевская, №13 Лизихитоны) и пустую сложность не заполняю.
--
-- Сезон: код `all` и пустое значение заменяются формулировкой паспорта
-- (месяцы; у Синичкина — «круглый год (паспорт)», потому что в паспорте
-- «круглогодично», а не код импорта). Пишем и в колонку season, и в
-- metadata.season: карточка и каталог читают payload = metadata.
--
-- Длина: у Толмачева в паспорте «60 км (в одну сторону)», на карточке
-- было 20,2 км; у Синичкина «7,3 км (в обе стороны)», было 4,1 км.
-- Признак стороны — колонка distance_note (в схеме её не было).
-- Ссылки на PDF — official_passport_url (и pdf_url, если он пуст).
--
-- Номер 1472: 1471 занят открытым PR #3587. Идемпотентно.

ALTER TABLE kamchatka_routes
  ADD COLUMN IF NOT EXISTS distance_note TEXT;

-- ── сезоны ──────────────────────────────────────────────────────────────
-- slug — адрес карточки на vedarai.ru.

UPDATE kamchatka_routes
SET season = v.season,
    metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{season}', to_jsonb(v.season)),
    updated_at = NOW()
FROM (VALUES
  ('visitkamchatka-vachkazhets-mountain-range-ski',            'декабрь - май'),
  ('visitkamchatka-vachkazhets-mountain-range-snowmobile',     'декабрь - май'),
  ('visitkamchatka-sup-nikolskaya',                            'лето, осень; июнь-октябрь'),
  ('visitkamchatka-sup-pinachevskaya',                         'лето, осень; июнь-октябрь'),
  ('visitkamchatka-sup-zavoiko',                               'лето, осень; июнь-октябрь'),
  ('visitkamchatka-calm-waterfall',                            'Лето-Осень; июль-октябрь'),
  ('visitkamchatka-mount-yurchik',                             'Лето-Осень; июнь-октябрь'),
  ('visitkamchatka-lysichitons',                               'Весна-лето; Середина мая-начало июня'),
  ('visitkamchatka-petropavlovsky-light-house-vertical-cape',  'Лето-Осень; июнь-октябрь'),
  ('ozero-tolmacheva',                                         'Лето-осень; Июнь-октябрь'),
  ('ozero-sinichkino-marshrut',                                'круглый год (паспорт)'),
  ('visitkamchatka-nerka',                                     'весна - осень; июнь - октябрь'),
  ('visitkamchatka-kuril-lake-eko',                            'весна - осень; май - октября')
) AS v(slug, season)
WHERE kamchatka_routes.slug = v.slug
  AND kamchatka_routes.merged_into_id IS NULL
  AND (
    kamchatka_routes.season IS DISTINCT FROM v.season
    OR kamchatka_routes.metadata->>'season' IS DISTINCT FROM v.season
  );

-- ── длина и ссылка на паспорт: озеро Толмачева (№15) ────────────────────
UPDATE kamchatka_routes
SET distance_km = 60,
    distance_note = 'в одну сторону',
    official_passport_url = 'https://visitkamchatka.ru/upload/route_passports/lake_tolmachevo.pdf',
    pdf_url = COALESCE(NULLIF(btrim(pdf_url), ''), 'https://visitkamchatka.ru/upload/route_passports/lake_tolmachevo.pdf'),
    passport_verified_at = COALESCE(passport_verified_at, NOW()),
    updated_at = NOW()
WHERE slug = 'ozero-tolmacheva'
  AND merged_into_id IS NULL
  AND (
    distance_km IS DISTINCT FROM 60
    OR distance_note IS DISTINCT FROM 'в одну сторону'
    OR official_passport_url IS DISTINCT FROM 'https://visitkamchatka.ru/upload/route_passports/lake_tolmachevo.pdf'
  );

-- ── длина и ссылка на паспорт: озеро Синичкино (№18) ────────────────────
UPDATE kamchatka_routes
SET distance_km = 7.3,
    distance_note = 'в обе стороны',
    official_passport_url = 'https://visitkamchatka.ru/upload/route_passports/lake_sinichkino.pdf',
    pdf_url = COALESCE(NULLIF(btrim(pdf_url), ''), 'https://visitkamchatka.ru/upload/route_passports/lake_sinichkino.pdf'),
    passport_verified_at = COALESCE(passport_verified_at, NOW()),
    updated_at = NOW()
WHERE slug = 'ozero-sinichkino-marshrut'
  AND merged_into_id IS NULL
  AND (
    distance_km IS DISTINCT FROM 7.3
    OR distance_note IS DISTINCT FROM 'в обе стороны'
    OR official_passport_url IS DISTINCT FROM 'https://visitkamchatka.ru/upload/route_passports/lake_sinichkino.pdf'
  );
