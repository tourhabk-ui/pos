-- Migration 1474: паспорта маршрутов, партия 1 — доводка по разбору 20.11 (#3568).
-- Created: 2026-11-20
--
-- Источник: чтение официальных PDF реестра visitkamchatka.ru глазами,
-- 2026-11-20 13:18–13:25 UTC; ответ в tourhabk-ui/flo-claude
-- answers/2026-11-20-passports-batch-1.md (commit 2669a5b). Разбор миграции
-- 1472 — там же, answers/2026-11-20-review-3589.md (commit 18d44af).
--
-- 1. Сезон Синичкина — словом паспорта. В п. 1.4 паспорта стоит
--    «круглогодично»; 1472 записала «круглый год (паспорт)», и служебное
--    «(паспорт)» стояло в подписи сезона на карточке. Источник показывает
--    ссылка на PDF рядом, а не слово в скобках.
-- 2. Дата сверки. 1472 ставила passport_verified_at = NOW() — время выката,
--    а не чтения паспорта. Ставим время чтения, только там, где 1472 его и
--    записала (позже чтения).
-- 3. Ссылка на официальный паспорт у 11 маршрутов, чей сезон 1472 записала
--    по этим же PDF. Ссылка у них была только в pdf_url (карточка писала
--    «Паспорт маршрута (PDF)» без отметки о проверке); теперь PDF прочитан и
--    совпадает с реестром — official_passport_url и дата чтения. URL каждого
--    паспорта — тот, что открылся при чтении (HTTP 200, application/pdf).
--
-- Только UPDATE по slug, повтор ничего не меняет.

BEGIN;

UPDATE kamchatka_routes
SET season = 'круглогодично',
    metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{season}', to_jsonb('круглогодично'::text)),
    updated_at = NOW()
WHERE slug = 'ozero-sinichkino-marshrut'
  AND merged_into_id IS NULL
  AND (season = 'круглый год (паспорт)' OR metadata->>'season' = 'круглый год (паспорт)');

UPDATE kamchatka_routes
SET passport_verified_at = TIMESTAMPTZ '2026-11-20 13:18:00+00',
    updated_at = NOW()
WHERE slug IN ('ozero-tolmacheva', 'ozero-sinichkino-marshrut')
  AND merged_into_id IS NULL
  AND passport_verified_at > TIMESTAMPTZ '2026-11-20 13:18:00+00';

UPDATE kamchatka_routes k
SET official_passport_url = v.url,
    pdf_url = COALESCE(NULLIF(btrim(k.pdf_url), ''), v.url),
    passport_verified_at = COALESCE(k.passport_verified_at, TIMESTAMPTZ '2026-11-20 13:18:00+00'),
    updated_at = NOW()
FROM (VALUES
  ('visitkamchatka-vachkazhets-mountain-range-ski',           'https://visitkamchatka.ru/upload/route_passports/vachkazhets_mountain_range_ski.pdf'),
  ('visitkamchatka-vachkazhets-mountain-range-snowmobile',    'https://visitkamchatka.ru/upload/route_passports/vachkazhets_mountain_range_snowmobile.pdf'),
  ('visitkamchatka-sup-nikolskaya',                           'https://visitkamchatka.ru/upload/route_passports/SUP-Nikolskaya.pdf'),
  ('visitkamchatka-sup-pinachevskaya',                        'https://visitkamchatka.ru/upload/route_passports/SUP_Pinachevskaya.pdf'),
  ('visitkamchatka-sup-zavoiko',                              'https://visitkamchatka.ru/upload/route_passports/SUP_Zavoiko.pdf'),
  ('visitkamchatka-calm-waterfall',                           'https://visitkamchatka.ru/upload/route_passports/calm_waterfall.pdf'),
  ('visitkamchatka-mount-yurchik',                            'https://visitkamchatka.ru/upload/route_passports/mount_yurchik.pdf'),
  ('visitkamchatka-lysichitons',                              'https://visitkamchatka.ru/upload/route_passports/lysichitons.pdf'),
  ('visitkamchatka-petropavlovsky-light-house-vertical-cape', 'https://visitkamchatka.ru/upload/route_passports/petropavlovsky_light_house_vertical_cape.pdf'),
  ('visitkamchatka-nerka',                                    'https://visitkamchatka.ru/upload/route_passports/nerka.pdf'),
  ('visitkamchatka-kuril-lake-eko',                           'https://visitkamchatka.ru/upload/route_passports/kuril_lake_eko.pdf')
) AS v(slug, url)
WHERE k.slug = v.slug
  AND k.merged_into_id IS NULL
  AND k.official_passport_url IS DISTINCT FROM v.url;

COMMIT;

-- Rollback: значения до 1474 — 1472 (сезон Синичкина, дата сверки) и NULL
-- в official_passport_url у 11 маршрутов; откат — обратными UPDATE по slug.
