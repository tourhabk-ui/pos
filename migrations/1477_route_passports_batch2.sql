-- Migration 1477: сезон, длина и ссылка на официальный паспорт по партии 2
-- задачи #3568 — 36 паспортов-сканов реестра visitkamchatka.ru.
--
-- Источник — чтение PDF глазами 20.11.2026, 17:07–17:08 UTC (21.11, 05:07–05:08
-- по Камчатке). Ответ: tourhabk-ui/flo-claude answers/2026-11-20-passports-batch-2.md
-- (commit 4a403ae7958b0021f95b325ef33d3a0eb8f730f2). Текстового слоя в этих PDF
-- нет — распознанному машиной тексту не верим. В миграцию идёт только то, где
-- чтение глазами совпало со второй, независимой сверкой (таблица #3568).
--
-- Что пишется:
-- 1. Сезон у 25 карточек реестра. До этого у них стоял код импорта `all`, а с
--    #3568 карточка его не показывает — сезона не было вовсе. Пишем слова
--    паспорта: время года (у бланка парка «Вулканы Камчатки») и месяцы. И в
--    колонку season, и в metadata.season: карточка и каталог читают payload.
-- 2. Длина у двух карточек реестра — со стороной, как в паспорте: Дыгерен —
--    Оленгендэ «17 км (в одну сторону)», было 22,77; Черемшанка «6,5 км (в одну
--    сторону)», было 5,21.
-- 3. Ссылка на официальный паспорт (official_passport_url, pdf_url — если пуст)
--    и дата чтения у 29 карточек: 28 карточек реестра — тот же маршрут, их
--    источник и есть этот паспорт, — и «Вулкан Горелый» (чтение: «тот же» —
--    стоянка у подножия и комбинированный способ совпадают).
--
-- Чего НЕ пишу, и почему:
-- - Красная сопка, Крокур: в паспорте «8 км (в одну сторону)» и «3 км (в одну
--   сторону)» при характере «кольцевой» — противоречие в самом бланке; на
--   карточках 16 и 6 км, ровно вдвое. Длину не трогаю.
-- - Хрустальные воды: в паспорте «4-5 часов», на карточке 4,5 ч — середина,
--   число в колонке «4-5» не запишет. Только ссылка.
-- - Вулкан Горелый: длина 6,1 км на карточке против «5 км (в одну сторону)»
--   пешего участка — откуда 6,1, не установлено. Только ссылка.
-- - Вилючинский водопад (два паспорта), Бабий камень, Котельное, Овальное,
--   Малкинские источники: «тот ли это маршрут», по карточке не понять — старт
--   и финиш не подписаны, длины другого рода. Вилючинский перевал — другая
--   нитка (76 км на машине от п. Геологи против 12,1 км у перевала). Ничего
--   не пишу: паспортную длину на чужую нитку не переносим.
--
-- Только UPDATE по slug; повтор ничего не меняет. Откат — обратными UPDATE по
-- slug: season и metadata.season вернуть в 'all', distance_km — 22.77 и 5.21
-- с distance_note NULL, official_passport_url — NULL.

-- ── сезоны ──────────────────────────────────────────────────────────────

UPDATE kamchatka_routes
SET season = v.season,
    metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{season}', to_jsonb(v.season)),
    updated_at = NOW()
FROM (VALUES
  -- бланк природного парка «Вулканы Камчатки»
  ('visitkamchatka-5-stroyka',           'зима-весна; декабрь - май'),
  ('visitkamchatka-po-sledam-ber',       'зима-весна; февраль - апрель'),
  ('visitkamchatka-talovsk-centre',      'зима-весна; декабрь - май'),
  ('visitkamchatka-chernyi-zamok',       'лето - осень; июнь - октябрь'),
  ('visitkamchatka-tolbachik',           'лето - осень; июнь - сентябрь'),
  ('visitkamchatka-pescher-gor',         'лето - осень; июнь - октябрь'),
  -- бланк Кроноцкого заповедника: «маршрут действует с … по …»
  ('visitkamchatka-khakytsin',           'июль - октябрь'),
  ('visitkamchatka-kron-liman',          'июль - сентябрь'),
  ('visitkamchatka-kuril-river',         'июнь - октябрь'),
  ('visitkamchatka-tugumynk',            'июль - октябрь'),
  ('visitkamchatka-krasnaya-sopka',      'июль - октябрь'),
  ('visitkamchatka-bear-glade',          'июль - октябрь'),
  ('visitkamchatka-mishki-sever',        'июль - октябрь'),
  ('visitkamchatka-bear-watching',       'июнь - октябрь'),
  ('visitkamchatka-kronoki-river',       'июль - сентябрь'),
  ('visitkamchatka-krokur-lake',         'июль - сентябрь'),
  ('visitkamchatka-lakes-mountain',      'июль - октябрь'),
  ('visitkamchatka-reindeer-road',       'июль - сентябрь'),
  ('visitkamchatka-bird-city',           'апрель - сентябрь; с 1 мая по 1 июля гнездовые участки закрыты'),
  ('visitkamchatka-ptichiy-polet',       'июль - октябрь'),
  ('visitkamchatka-kuril-lake',          'июнь - октябрь'),
  ('visitkamchatka-tumany',              'июль - октябрь'),
  ('visitkamchatka-uzon-blue-dol',       'июль - сентябрь'),
  ('visitkamchatka-kuth-kingdom',        'июль - сентябрь'),
  ('visitkamchatka-istok-krash-death',   '1 августа - 15 сентября')
) AS v(slug, season)
WHERE kamchatka_routes.slug = v.slug
  AND kamchatka_routes.merged_into_id IS NULL
  AND (
    kamchatka_routes.season IS DISTINCT FROM v.season
    OR kamchatka_routes.metadata->>'season' IS DISTINCT FROM v.season
  );

-- ── длина со стороной ───────────────────────────────────────────────────

UPDATE kamchatka_routes
SET distance_km = v.km,
    distance_note = v.note,
    updated_at = NOW()
FROM (VALUES
  ('visitkamchatka-volcano-dygeren',  17::numeric,  'в одну сторону'),
  ('visitkamchatka-cheremshanka',     6.5::numeric, 'в одну сторону')
) AS v(slug, km, note)
WHERE kamchatka_routes.slug = v.slug
  AND kamchatka_routes.merged_into_id IS NULL
  AND (
    kamchatka_routes.distance_km IS DISTINCT FROM v.km
    OR kamchatka_routes.distance_note IS DISTINCT FROM v.note
  );

-- ── ссылка на официальный паспорт и дата чтения ─────────────────────────

UPDATE kamchatka_routes k
SET official_passport_url = v.url,
    pdf_url = COALESCE(NULLIF(btrim(k.pdf_url), ''), v.url),
    passport_verified_at = COALESCE(k.passport_verified_at, TIMESTAMPTZ '2026-11-20 17:07:00+00'),
    updated_at = NOW()
FROM (VALUES
  ('visitkamchatka-volcano-dygeren',   'https://visitkamchatka.ru/upload/route_passports/volcano_dygeren_winter.pdf'),
  ('visitkamchatka-5-stroyka',         'https://visitkamchatka.ru/upload/route_passports/5_stroyka.pdf'),
  ('visitkamchatka-po-sledam-ber',     'https://visitkamchatka.ru/upload/route_passports/po_sledam_ber.pdf'),
  ('visitkamchatka-talovsk-centre',    'https://visitkamchatka.ru/upload/route_passports/talovsk_centre.pdf'),
  ('visitkamchatka-cheremshanka',      'https://visitkamchatka.ru/upload/route_passports/cheremshanka.pdf'),
  ('visitkamchatka-chernyi-zamok',     'https://visitkamchatka.ru/upload/route_passports/chernyi_zamok.pdf'),
  ('visitkamchatka-tolbachik',         'https://visitkamchatka.ru/upload/route_passports/tolbachik.pdf'),
  ('vulkan-gorelyy-3d0e808c',          'https://visitkamchatka.ru/upload/route_passports/gorel_volcano_summer.pdf'),
  ('visitkamchatka-pescher-gor',       'https://visitkamchatka.ru/upload/route_passports/pescher_gor.pdf'),
  ('visitkamchatka-khakytsin',         'https://visitkamchatka.ru/upload/route_passports/khakytsin.pdf'),
  ('visitkamchatka-kron-liman',        'https://visitkamchatka.ru/upload/route_passports/kron_liman.pdf'),
  ('visitkamchatka-kuril-river',       'https://visitkamchatka.ru/upload/route_passports/kuril_river.pdf'),
  ('visitkamchatka-tugumynk',          'https://visitkamchatka.ru/upload/route_passports/tugumynk.pdf'),
  ('visitkamchatka-krasnaya-sopka',    'https://visitkamchatka.ru/upload/route_passports/krasnaya_sopka.pdf'),
  ('visitkamchatka-bear-glade',        'https://visitkamchatka.ru/upload/route_passports/bear_glade.pdf'),
  ('visitkamchatka-mishki-sever',      'https://visitkamchatka.ru/upload/route_passports/mishki_sever.pdf'),
  ('visitkamchatka-bear-watching',     'https://visitkamchatka.ru/upload/route_passports/bear_watching.pdf'),
  ('visitkamchatka-kronoki-river',     'https://visitkamchatka.ru/upload/route_passports/kronoki_river.pdf'),
  ('visitkamchatka-krokur-lake',       'https://visitkamchatka.ru/upload/route_passports/krokur_lake.pdf'),
  ('visitkamchatka-lakes-mountain',    'https://visitkamchatka.ru/upload/route_passports/lakes_mountain.pdf'),
  ('visitkamchatka-reindeer-road',     'https://visitkamchatka.ru/upload/route_passports/reindeer_road.pdf'),
  ('visitkamchatka-bird-city',         'https://visitkamchatka.ru/upload/route_passports/bird_city.pdf'),
  ('visitkamchatka-ptichiy-polet',     'https://visitkamchatka.ru/upload/route_passports/ptichiy_polet.pdf'),
  ('visitkamchatka-kuril-lake',        'https://visitkamchatka.ru/upload/route_passports/kuril_lake.pdf'),
  ('visitkamchatka-tumany',            'https://visitkamchatka.ru/upload/route_passports/tumany.pdf'),
  ('visitkamchatka-uzon-blue-dol',     'https://visitkamchatka.ru/upload/route_passports/uzon_blue_dol.pdf'),
  ('visitkamchatka-crystal-waters',    'https://visitkamchatka.ru/upload/route_passports/crystal_waters.pdf'),
  ('visitkamchatka-kuth-kingdom',      'https://visitkamchatka.ru/upload/route_passports/kuth_kingdom.pdf'),
  ('visitkamchatka-istok-krash-death', 'https://visitkamchatka.ru/upload/route_passports/istok_krash_death.pdf')
) AS v(slug, url)
WHERE k.slug = v.slug
  AND k.merged_into_id IS NULL
  -- Чужую официальную ссылку не переписываем: у карточки уже может стоять
  -- паспорт парка. Пусто — ставим; та же ссылка — повтор ничего не меняет.
  AND NULLIF(btrim(k.official_passport_url), '') IS NULL;
