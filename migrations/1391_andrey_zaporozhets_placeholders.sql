-- Migration 1391: аккаунт Андрея Запорожца — держатели id по базе, не по списку (04.11)
--
-- 1390 задавала всё явными id и на проде остановилась (P0001): заглушку
-- входа через Telegram (259dd12b, tg_<id>@telegram.local) она знала, а
-- заглушку входа через MAX (max_<id>@max.local) — нет: её создал сам гид,
-- войдя через MAX в 13:04 по Камчатке 04.11, до выката 1390 (скриншот
-- владельца: «а это уже через макс — зашёл как чистый турист»). Карточка B
-- без владельца → вход через мессенджер заводит пустого туриста (1386).
--
-- Факты из админки (04.11), неизменные:
--   4e2ae003-d54e-4a5d-9604-30d4e948ff09 — аккаунт zap.andy@gmail.com (guide,
--     вход по паролю работает — скриншот кабинета гида 13:01).
--   A d9d1d230-4f18-4917-84f1-59b8fafb11c2 — пустая карточка из регистрации.
--   B 95fe571f-9e99-400e-bdc3-a1682bf3175e — настоящая andrey-zaporozhets.
--
-- Что иначе, чем в 1390: держатели MAX/Telegram id ищутся запросом по users.
-- Каждый держатель обязан быть заглушкой мессенджера (role tourist, почта
-- max_<id>@max.local или tg_<id>@telegram.local) без броней
-- (operator_bookings.user_id), карточек (partners.user_id) и туров
-- (operator_tours.created_by) — тогда id снимаются, заглушка выключается,
-- сессии удаляются, прочие её строки (память Кузьмича и т.п.) остаются и
-- называются в NOTICE. Настоящий аккаунт среди держателей — стоп.
-- Остальное как в 1390: одна транзакция, проверки → стоп с откатом, почта
-- подтверждена, если признак есть в схеме; бэкап строк; ссылки A → B; A
-- suspended; B — владелец 4e2ae003. MAX id не печатаются нигде — в том
-- числе почта заглушки, которая его содержит. Повтор — без изменений.

BEGIN;

DO $mig$
DECLARE
  c_uid CONSTANT TEXT := '4e2ae003-d54e-4a5d-9604-30d4e948ff09';
  c_a   CONSTANT TEXT := 'd9d1d230-4f18-4917-84f1-59b8fafb11c2';
  c_b   CONSTANT TEXT := '95fe571f-9e99-400e-bdc3-a1682bf3175e';
  u  users%ROWTYPE;
  a  partners%ROWTYPE;
  b  partners%ROWTYPE;
  h  users%ROWTYPE;
  has_a BOOLEAN;
  verified BOOLEAN;
  mx BIGINT;
  tg BIGINT;
  n INT;
  r RECORD;
  found_row BOOLEAN;
  tbls TEXT;
  holders INT := 0;
BEGIN
  SELECT * INTO b FROM partners WHERE id::text = c_b FOR UPDATE;
  IF NOT FOUND THEN RAISE NOTICE '1391: карточки % нет — пропуск', c_b; RETURN; END IF;
  SELECT * INTO u FROM users WHERE id::text = c_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '1391: карточка B есть, а аккаунта % нет — стоп', c_uid; END IF;
  SELECT * INTO a FROM partners WHERE id::text = c_a FOR UPDATE;  has_a := FOUND;

  IF lower(btrim(COALESCE(u.email, ''))) <> 'zap.andy@gmail.com' THEN
    RAISE EXCEPTION '1391: у % почта «%», ждали zap.andy@gmail.com', c_uid, u.email; END IF;

  -- Почта подтверждена? Признак — колонка users (если есть) или metadata.
  verified := NULL;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified') THEN
    EXECUTE 'SELECT email_verified IS TRUE FROM users WHERE id::text = $1' INTO verified USING c_uid;
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified_at') THEN
    EXECUTE 'SELECT email_verified_at IS NOT NULL FROM users WHERE id::text = $1' INTO verified USING c_uid;
  ELSIF u.metadata ? 'email_verified' THEN
    verified := COALESCE(u.metadata->>'email_verified', '') IN ('true', 't', '1');
  END IF;
  IF verified IS FALSE THEN
    RAISE EXCEPTION '1391: почта zap.andy@gmail.com у % не подтверждена — стоп', c_uid; END IF;
  IF verified IS NULL THEN
    RAISE NOTICE '1391: в схеме нет признака подтверждения почты (email_verified / email_verified_at / metadata) — проверка не применима';
  END IF;

  IF b.slug IS DISTINCT FROM 'andrey-zaporozhets' THEN
    RAISE EXCEPTION '1391: у карточки B слаг «%»', b.slug; END IF;
  IF b.user_id IS NOT NULL AND b.user_id::text <> c_uid THEN
    RAISE EXCEPTION '1391: у карточки B другой владелец %', b.user_id; END IF;
  IF has_a AND a.user_id IS NOT NULL AND a.user_id::text <> c_uid THEN
    RAISE EXCEPTION '1391: у карточки A другой владелец %', a.user_id; END IF;

  -- MAX и Telegram id — с карточек и аккаунта; все известные значения совпадают.
  -- Сами id не печатаются.
  SELECT count(DISTINCT v), min(v) INTO n, mx FROM (VALUES
    (CASE WHEN has_a THEN a.max_owner_user_id END), (b.max_owner_user_id), (u.max_user_id)) s(v) WHERE v IS NOT NULL;
  IF n > 1 THEN RAISE EXCEPTION '1391: MAX ids differ — стоп'; END IF;
  SELECT count(DISTINCT v), min(v) INTO n, tg FROM (VALUES
    (b.telegram_owner_user_id), (CASE WHEN b.telegram_chat_id > 0 THEN b.telegram_chat_id END), (u.telegram_id)) s(v) WHERE v IS NOT NULL;
  IF n > 1 THEN RAISE EXCEPTION '1391: Telegram ids differ — стоп'; END IF;

  -- Уже сделано?
  IF b.user_id::text = c_uid
     AND (NOT has_a OR (a.status = 'suspended' AND a.user_id IS NULL AND a.max_owner_user_id IS NULL))
     AND NOT EXISTS (SELECT 1 FROM users WHERE id::text <> c_uid
                       AND ((mx IS NOT NULL AND max_user_id = mx) OR (tg IS NOT NULL AND telegram_id = tg))) THEN
    RAISE NOTICE '1391: уже сделано — без изменений'; RETURN;
  END IF;

  SELECT count(*) INTO n FROM partners WHERE user_id::text = c_uid AND id::text NOT IN (c_a, c_b);
  IF n > 0 THEN RAISE EXCEPTION '1391: у % ещё карточек: %', c_uid, n; END IF;
  IF has_a AND COALESCE(btrim(a.description), '') <> '' THEN
    RAISE EXCEPTION '1391: у карточки A есть описание — не пустая, стоп'; END IF;

  RAISE NOTICE '1391: has_password %', CASE WHEN COALESCE(u.password_hash, '') <> '' THEN 'true' ELSE 'false' END;
  RAISE NOTICE '1391 BACKUP users %', row_to_json(u)::jsonb - 'max_user_id' - 'password_hash' - 'mfa_secret';
  RAISE NOTICE '1391 BACKUP partners %', CASE WHEN has_a THEN row_to_json(a)::jsonb - 'max_owner_user_id' END;
  RAISE NOTICE '1391 BACKUP partners %', row_to_json(b)::jsonb - 'max_owner_user_id';

  -- Держатели id (кроме самого аккаунта): только заглушки мессенджеров и
  -- только пустые по делу. Сначала они отдают id, затем их получает 4e2ae003
  -- (уникальные индексы). Живые таблицы: operator_bookings, operator_tours.
  FOR h IN
    SELECT * FROM users
     WHERE id::text <> c_uid
       AND ((mx IS NOT NULL AND max_user_id = mx) OR (tg IS NOT NULL AND telegram_id = tg))
     ORDER BY created_at, id
     FOR UPDATE
  LOOP
    holders := holders + 1;
    IF h.role IS DISTINCT FROM 'tourist'
       OR NOT (h.email LIKE 'max\_%@max.local' OR h.email LIKE 'tg\_%@telegram.local') THEN
      RAISE EXCEPTION '1391: MAX или Telegram id держит настоящий аккаунт % (не заглушка мессенджера) — стоп', h.id;
    END IF;
    IF EXISTS (SELECT 1 FROM operator_bookings WHERE user_id::text = h.id::text) THEN
      RAISE EXCEPTION '1391: у заглушки % есть брони — стоп', h.id; END IF;
    IF EXISTS (SELECT 1 FROM partners WHERE user_id::text = h.id::text) THEN
      RAISE EXCEPTION '1391: у заглушки % есть карточки — стоп', h.id; END IF;
    IF EXISTS (SELECT 1 FROM operator_tours WHERE created_by::text = h.id::text) THEN
      RAISE EXCEPTION '1391: у заглушки % есть туры — стоп', h.id; END IF;

    tbls := '';
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a2.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a2 ON a2.attrelid = c.conrelid AND a2.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND array_length(c.conkey, 1) = 1
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I::text = $1)', r.tbl, r.col) INTO found_row USING h.id::text;
      IF found_row THEN tbls := tbls || r.tbl || '.' || r.col || ' '; END IF;
    END LOOP;
    RAISE NOTICE '1391: заглушка % (%): строки в таблицах: %', h.id,
      CASE WHEN h.email LIKE 'max\_%' THEN 'MAX' ELSE 'Telegram' END, COALESCE(NULLIF(btrim(tbls), ''), 'нет');
    -- Почта заглушки содержит MAX/Telegram id — в бэкап не идёт.
    RAISE NOTICE '1391 BACKUP users %', row_to_json(h)::jsonb - 'max_user_id' - 'telegram_id' - 'email' - 'password_hash' - 'mfa_secret';

    UPDATE users SET max_user_id = NULL, telegram_id = NULL, is_active = FALSE, updated_at = NOW()
     WHERE id::text = h.id::text;
    DELETE FROM user_sessions WHERE user_id::text = h.id::text;
    RAISE NOTICE '1391: заглушка % выключена, id сняты', h.id;
  END LOOP;
  RAISE NOTICE '1391: держателей id кроме аккаунта: %', holders;

  UPDATE users SET
    max_user_id = COALESCE(mx, max_user_id),
    telegram_id = COALESCE(tg, telegram_id),
    role = CASE WHEN role IN ('tourist', 'guide') THEN 'guide' ELSE role END,
    updated_at = NOW()
   WHERE id::text = c_uid;

  -- Всё, что ссылается на A (заявки, туры с бронями, черновики), — на B.
  -- Служебные строки регистрации остаются у A.
  IF has_a THEN
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a2.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a2 ON a2.attrelid = c.conrelid AND a2.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'partners'::regclass AND array_length(c.conkey, 1) = 1
         AND c.conrelid::regclass::text NOT IN
             ('partners', 'operator_applications', 'operator_settings', 'operator_stats_cache', 'operator_ai_config')
       ORDER BY 1, 2
    LOOP
      EXECUTE format('UPDATE %s SET %I = $2 WHERE %I::text = $1', r.tbl, r.col, r.col) USING c_a, b.id;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE NOTICE '1391: с карточки A на B перенесено % строк в %.%', n, r.tbl, r.col; END IF;
    END LOOP;

    UPDATE partners SET status = 'suspended', is_public = FALSE, user_id = NULL,
                        max_owner_user_id = NULL, updated_at = NOW()
     WHERE id::text = c_a;
  END IF;

  UPDATE partners SET user_id = u.id, updated_at = NOW() WHERE id::text = c_b;

  RAISE NOTICE '1391: готово — B владелец 4e2ae003, A suspended, заглушек выключено: %', holders;
END
$mig$;

COMMIT;
