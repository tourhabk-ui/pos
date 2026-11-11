-- 1420: «Лагуна Экспедиция» — открыты даты опубликованных туров: каждый день в
-- сезоне тура, мест на дату — вместимость тура.
-- Created: 2026-11-11
--
-- ── Основание ─────────────────────────────────────────────────────────────
--
-- Слово владельца 11.11: «Лагуне открой все даты». На вопрос, какие именно, —
-- «По сезону тура»: каждый день, но только в сезон, названный самим туром,
-- круглогодичные — круглый год, на 12 месяцев вперёд; новогодние — в
-- новогодние даты. На вопрос о местах — «Вместимость тура».
--
-- До этого у туров «Лагуны Экспедиции» (1339, 1413) не было ни одной даты в
-- календаре и ни одного сезона: витрина писала «Расписания в системе нет», а
-- каждая заявка уходила оператору запросом мест.
--
-- ── Сезон каждого тура — откуда, а не догадка ────────────────────────────
--
-- Выписаны все слова о сезоне из полей каждого тура (название, описание,
-- программа, «входит», «что взять», примечание к цене). Окно взято там, где
-- его назвал оператор:
--
--   • выезды календаря на страницах оператора, снятых 08.11.2026 (шапка 1413):
--       36212, 36214 «Вулканы Камчатки (4 дня / 5 дней)» — 09.11.2026–20.06.2027;
--       37577 «Камчатка на максимум: летний маршрут»,
--       37584 «Камчатка: летний экспресс»                 — 15.06–30.09.2027;
--       41610 «Камчатка на максимум: зимний маршрут»       — 13.11.2026–10.04.2027;
--       51446 «Вулканы Камчатки 4 дня (новогодние праздники)» — 25.12.2026–08.01.2027;
--
--   • зимние однодневки — снегоход и нарта по снегу: «За снегоходом на Мыс
--     Маячный» («настоящее зимнее приключение», «по заснеженным просторам»),
--     «Два вулкана (Авачинский перевал) в снегоходной нарте» («по живописной
--     зимней дороге среди заснеженных склонов»), «К Домашним вулканам на
--     вездеходе Sever Truck» («Зимой сюда не доехать на обычной машине… по
--     глубокому снегу», «по снежному плато»). Своих дат в тексте нет; окно —
--     выезды зимнего маршрута того же оператора (41610, 13.11.2026–10.04.2027),
--     в программе которого стоит тот же день: «В нарте за снегоходом к мысу
--     Маячному или Авачинскому перевалу»;
--
--   • новогодние туры 1339 — «Камчатка: здесь начинается Новый год» и оба
--     «Новогодних вулкана Камчатки». В их тексте дат нет, кроме банкета
--     31.12.2026 («Если даты тура выпадают на 31.12.2026…»). Окно — новогодние
--     выезды того же оператора (51446, 25.12.2026–08.01.2027);
--
--   • остальные 18 туров сезона в тексте не называют: ни месяцев, ни «зимой»
--     или «летом» как условия поездки. Тёплая одежда и солнцезащитный крем в
--     «что взять» сезона не называют; «зимой на Халактырском озере можно
--     встретить лебедей» («Первый рассвет») — о том, что тур идёт и зимой.
--     Эти туры открыты круглый год, на 12 месяцев вперёд, а сезон в тур не
--     пишется: NULL — «не записан», а не выдуманное окно. Что из этого
--     оператор не возит в какой-то месяц, он закрывает сам, в кабинете.
--
-- Не открываются туры, снятые с витрины: восемь в архиве оператора (1408),
-- «Дачные горячие источники на вездеходе Sever Truck» (1412) и черновик
-- «Халактырский пляж» (1339).
--
-- ── Как ──────────────────────────────────────────────────────────────────
--
--   • Окно — выезды: даты с первого выезда по последний. В тур пишется
--     season_start = первый выезд и season_end = последний выезд + (дней тура
--     − 1), чтобы окно заявки (lib/tours/request-window) кончалось последним
--     выездом. Сезон пишется, только если у тура его нет: окно, которое
--     оператор поставил сам, не перетирается — и даты открываются в его окне,
--     а не в нашем. Даты открываются по сезону, записанному в туре после этой
--     правки: нет сезона — круглый год.
--   • Даты — каждый день окна, не раньше сегодняшнего дня по Камчатке и не
--     дальше того же дня через год (горизонт кабинета, horizonLastDate). Мест
--     — max_participants тура в момент миграции; тур без вместимости не
--     открывается и называется.
--   • Строка календаря, которая уже есть, не трогается вовсе (ON CONFLICT DO
--     NOTHING): открытая оператором — с его местами, закрытая — закрыта,
--     удалённая — удалена.
--   • Многодневные открыты каждым днём выезда, как велел владелец; бронь
--     многодневного тура занимает места на все свои дни (lib/bookings/occupancy),
--     так что перекрытые выезды делят одну вместимость.
--   • Только опубликованные и активные туры карточки laguna-expedition по
--     адресу из списка ниже. Тур этой карточки не из списка (заведён позже)
--     не трогается и называется в исходе.
--
-- Персональных данных здесь нет. IDEMPOTENT: повтор не добавляет строк и не
-- меняет сезона. Исход — WARNING в конце.

BEGIN;

CREATE TEMP TABLE _lagexp_dates (slug text PRIMARY KEY, first_dep date, last_dep date) ON COMMIT DROP;

INSERT INTO _lagexp_dates (slug, first_dep, last_dep) VALUES
  -- выезды календаря оператора, 08.11.2026 (1413)
  ('lagexp-vulkany-kamchatki-4-dnya',                       DATE '2026-11-09', DATE '2027-06-20'),
  ('lagexp-vulkany-kamchatki-5-dnej',                       DATE '2026-11-09', DATE '2027-06-20'),
  ('lagexp-kamchatka-na-maksimum-letnij-marshrut',          DATE '2027-06-15', DATE '2027-09-30'),
  ('lagexp-kamchatka-letnij-ekspress',                      DATE '2027-06-15', DATE '2027-09-30'),
  ('lagexp-kamchatka-na-maksimum-zimnij-marshrut',          DATE '2026-11-13', DATE '2027-04-10'),
  ('lagexp-vulkany-kamchatki-4-dnya-novogodnie-prazdniki',  DATE '2026-12-25', DATE '2027-01-08'),
  -- зимние однодневки: окно зимнего маршрута 41610
  ('lagexp-mys-mayachnyj',                                  DATE '2026-11-13', DATE '2027-04-10'),
  ('lagexp-dva-vulkana-avachinskij-pereval',                DATE '2026-11-13', DATE '2027-04-10'),
  ('lagexp-k-domashnim-vulkanam-na-vezdekhode-sever-truck', DATE '2026-11-13', DATE '2027-04-10'),
  -- новогодние 1339: новогоднее окно 51446
  ('lagexp-novyj-god-na-kamchatke',                         DATE '2026-12-25', DATE '2027-01-08'),
  ('lagexp-novogodnie-vulkany-kamchatki-laguna-4',          DATE '2026-12-25', DATE '2027-01-08'),
  ('lagexp-novogodnie-vulkany-kamchatki-sanatorij-zhemchuzhina-kamchatki', DATE '2026-12-25', DATE '2027-01-08'),
  -- сезон в тексте не назван: круглый год, 12 месяцев вперёд, сезон не пишется
  ('lagexp-malkinskie-dikie-goryachie-mineralnye-istochniki', NULL, NULL),
  ('lagexp-na-kraj-sveta-mys-mayachnyj',                    NULL, NULL),
  ('lagexp-mys-mayachnyj-khalaktyrskij-plyazh',             NULL, NULL),
  ('lagexp-k-gamulam-na-vilyuchinskij-pereval',             NULL, NULL),
  ('lagexp-siti-tur-tuda-gde-vstaet-solntse',               NULL, NULL),
  ('lagexp-konnaya-progulka',                               NULL, NULL),
  ('lagexp-karymshinskie-termalnye-istochniki',             NULL, NULL),
  ('lagexp-pervyj-rassvet',                                 NULL, NULL),
  ('lagexp-chasovaya-progulka',                             NULL, NULL),
  ('lagexp-kanon-opasnyj',                                  NULL, NULL),
  ('lagexp-obljot-vulkanov-vilyuchinskij-mutnovskij-i-gorelyj-vertoljotnaya-ekskursiya', NULL, NULL),
  ('lagexp-pitomnik-ezdovykh-sobak-snezhnye-psy',           NULL, NULL),
  ('lagexp-dukh-kamchatki',                                 NULL, NULL),
  ('lagexp-zelenovskie-ozerki',                             NULL, NULL),
  ('lagexp-pogruzhenie-v-kulturu-severa',                   NULL, NULL),
  ('lagexp-obljot-avachinskoj-bukhty-i-avachinskogo-vulkana-timonovskie-istochniki', NULL, NULL),
  ('lagexp-okhotskoe-more',                                 NULL, NULL),
  ('lagexp-kamchatka-termalnyj-marshrut',                   NULL, NULL);

-- Сезон — только тем, у кого он назван, и только если оператор не поставил свой.
UPDATE operator_tours t
   SET season_start = s.first_dep,
       season_end   = s.last_dep + (CASE WHEN t.duration_type = 'multi_day' AND t.multi_day_count > 0
                                         THEN t.multi_day_count - 1 ELSE 0 END),
       updated_at   = NOW()
  FROM _lagexp_dates s, partners p
 WHERE t.slug = s.slug
   AND p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
   AND s.first_dep IS NOT NULL
   AND t.season_start IS NULL AND t.season_end IS NULL
   AND t.deleted_at IS NULL
   AND COALESCE(t.is_published, FALSE) AND COALESCE(t.is_active, FALSE);

-- Даты: каждый день выездов по сезону тура (записанному выше или
-- оператором), от сегодня по Камчатке до того же дня через год. Нет сезона —
-- круглый год. Последний выезд — конец сезона минус (дней тура − 1).
INSERT INTO tour_availability (operator_tour_id, date, day_of_week, available_slots)
SELECT t.id, d.day, EXTRACT(DOW FROM d.day)::int, t.max_participants
  FROM _lagexp_dates s
  JOIN operator_tours t ON t.slug = s.slug
  JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
  CROSS JOIN LATERAL (
    SELECT (NOW() AT TIME ZONE 'Asia/Kamchatka')::date AS today,
           ((NOW() AT TIME ZONE 'Asia/Kamchatka')::date + INTERVAL '1 year')::date AS horizon,
           CASE WHEN t.duration_type = 'multi_day' AND t.multi_day_count > 0 THEN t.multi_day_count - 1 ELSE 0 END AS extra
  ) w
  CROSS JOIN LATERAL (
    SELECT g::date AS day
      FROM generate_series(
             GREATEST(COALESCE(t.season_start, w.today), w.today)::timestamp,
             LEAST(COALESCE(t.season_end - w.extra, w.horizon), w.horizon)::timestamp,
             INTERVAL '1 day') AS g
  ) d
 WHERE t.deleted_at IS NULL
   AND COALESCE(t.is_published, FALSE) AND COALESCE(t.is_active, FALSE)
   AND t.max_participants >= 1
ON CONFLICT (operator_tour_id, date) DO NOTHING;

-- Исход вслух: сколько туров открыто, чего нет и почему.
DO $$
DECLARE
  v_p int;
  v_live int;
  v_open int;
  v_listed int;
  v_other text;
  v_noseats text;
BEGIN
  SELECT count(*) INTO v_p FROM partners WHERE slug = 'laguna-expedition';
  IF v_p <> 1 THEN
    RAISE WARNING '[1420] карточек laguna-expedition: % (нужна одна, её заводит 1323) — даты не открыты', v_p;
    RETURN;
  END IF;
  SELECT count(*) INTO v_live FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
   WHERE t.deleted_at IS NULL AND COALESCE(t.is_published, FALSE) AND COALESCE(t.is_active, FALSE);
  SELECT count(*) INTO v_listed FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN _lagexp_dates s ON s.slug = t.slug
   WHERE t.deleted_at IS NULL AND COALESCE(t.is_published, FALSE) AND COALESCE(t.is_active, FALSE);
  SELECT count(DISTINCT t.id) INTO v_open FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN tour_availability a ON a.operator_tour_id::text = t.id::text
   WHERE t.deleted_at IS NULL AND COALESCE(t.is_published, FALSE) AND COALESCE(t.is_active, FALSE)
     AND a.deleted_at IS NULL AND COALESCE(a.is_cancelled, FALSE) = FALSE AND a.available_slots > 0
     AND a.date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date;
  SELECT string_agg(t.title, '; ' ORDER BY t.title) INTO v_other FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
   WHERE t.deleted_at IS NULL AND COALESCE(t.is_published, FALSE) AND COALESCE(t.is_active, FALSE)
     AND NOT EXISTS (SELECT 1 FROM _lagexp_dates s WHERE s.slug = t.slug);
  SELECT string_agg(t.title, '; ' ORDER BY t.title) INTO v_noseats FROM operator_tours t
    JOIN partners p ON p.id::text = t.operator_id::text AND p.slug = 'laguna-expedition'
    JOIN _lagexp_dates s ON s.slug = t.slug
   WHERE t.deleted_at IS NULL AND COALESCE(t.is_published, FALSE) AND COALESCE(t.is_active, FALSE)
     AND NOT (t.max_participants >= 1);
  RAISE WARNING '[1420] «Лагуна Экспедиция»: опубликованных туров %, из списка %, с открытыми датами впереди %', v_live, v_listed, v_open;
  IF v_other IS NOT NULL THEN
    RAISE WARNING '[1420] не из списка, даты не открывались: %', v_other;
  END IF;
  IF v_noseats IS NOT NULL THEN
    RAISE WARNING '[1420] без вместимости, даты не открыты: %', v_noseats;
  END IF;
END $$;

COMMIT;

-- Rollback (по номеру тура; открытые миграцией строки — те, что без брони):
-- DELETE FROM tour_availability a USING operator_tours t, partners p
--  WHERE a.operator_tour_id = t.id AND p.id::text = t.operator_id::text
--    AND p.slug = 'laguna-expedition' AND COALESCE(a.booked_slots, 0) = 0
--    AND a.created_at::date = '<день выката>';
-- UPDATE operator_tours SET season_start = NULL, season_end = NULL WHERE slug IN (<окна выше>);
