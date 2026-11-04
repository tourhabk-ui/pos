-- Migration 1390: аккаунт Андрея Запорожца — по явным id (04.11, вместо 1389)
--
-- Факты из админки (/api/admin/operators, 04.11):
--   4e2ae003-d54e-4a5d-9604-30d4e948ff09 — аккаунт zap.andy@gmail.com (guide).
--   259dd12b-7025-430e-9baa-254a08a37f39 — заглушка входа через Telegram
--     (tg_221997120@telegram.local, tourist, 0 броней). Держит MAX/TG id
--     Андрея; 1389 из-за её служебных строк остановилась.
--   A d9d1d230-4f18-4917-84f1-59b8fafb11c2 — пустая карточка из регистрации
--     (аккаунт 4e2ae003, MAX есть, TG нет, скрыта, слага нет).
--   B 95fe571f-9e99-400e-bdc3-a1682bf3175e — настоящая andrey-zaporozhets
--     (аккаунта нет, MAX+TG, telegram_chat_id 221997120, публичная).
--
-- Одной транзакцией:
--   1) проверки; любая неоднозначность — EXCEPTION, откат всего;
--      почта 4e2ae003 должна быть подтверждена, если в схеме есть признак;
--   2) NOTICE: есть ли пароль у 4e2ae003 (да/нет, на ход не влияет), в каких
--      таблицах строки заглушки; бэкап четырёх строк без MAX id;
--   3) Telegram/MAX id: сначала снимаются с заглушки 259dd12b (она
--      выключается, сессии удаляются, строка остаётся), затем ставятся
--      4e2ae003 — уникальные индексы не мешают;
--   4) заявки, туры (с их бронями) и прочие ссылки карточки A переносятся
--      на B; A — suspended, скрыта, без аккаунта и без MAX;
--   5) B: владелец 4e2ae003.
-- MAX id нигде не печатаются. Повторный запуск — без изменений.

BEGIN;

DO $mig$
DECLARE
  c_uid CONSTANT TEXT := '4e2ae003-d54e-4a5d-9604-30d4e948ff09';
  c_ph  CONSTANT TEXT := '259dd12b-7025-430e-9baa-254a08a37f39';
  c_a   CONSTANT TEXT := 'd9d1d230-4f18-4917-84f1-59b8fafb11c2';
  c_b   CONSTANT TEXT := '95fe571f-9e99-400e-bdc3-a1682bf3175e';
  u  users%ROWTYPE;
  ph users%ROWTYPE;
  a  partners%ROWTYPE;
  b  partners%ROWTYPE;
  has_ph BOOLEAN;
  has_a BOOLEAN;
  verified BOOLEAN;
  mx BIGINT;
  tg BIGINT;
  n INT;
  r RECORD;
  found_row BOOLEAN;
  tbls TEXT := '';
BEGIN
  SELECT * INTO b FROM partners WHERE id::text = c_b FOR UPDATE;
  IF NOT FOUND THEN RAISE NOTICE '1390: карточки % нет — пропуск', c_b; RETURN; END IF;
  SELECT * INTO u FROM users WHERE id::text = c_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '1390: карточка B есть, а аккаунта % нет — стоп', c_uid; END IF;
  SELECT * INTO a FROM partners WHERE id::text = c_a FOR UPDATE;  has_a := FOUND;
  SELECT * INTO ph FROM users WHERE id::text = c_ph FOR UPDATE;   has_ph := FOUND;

  IF lower(btrim(COALESCE(u.email, ''))) <> 'zap.andy@gmail.com' THEN
    RAISE EXCEPTION '1390: у % почта «%», ждали zap.andy@gmail.com', c_uid, u.email; END IF;

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
    RAISE EXCEPTION '1390: почта zap.andy@gmail.com у % не подтверждена — стоп', c_uid; END IF;
  IF verified IS NULL THEN
    RAISE NOTICE '1390: в схеме нет признака подтверждения почты (email_verified / email_verified_at / metadata) — проверка не применима';
  END IF;

  IF b.slug IS DISTINCT FROM 'andrey-zaporozhets' THEN
    RAISE EXCEPTION '1390: у карточки B слаг «%»', b.slug; END IF;
  IF b.user_id IS NOT NULL AND b.user_id::text <> c_uid THEN
    RAISE EXCEPTION '1390: у карточки B другой владелец %', b.user_id; END IF;
  IF has_a AND a.user_id IS NOT NULL AND a.user_id::text <> c_uid THEN
    RAISE EXCEPTION '1390: у карточки A другой владелец %', a.user_id; END IF;

  -- Уже сделано?
  IF b.user_id::text = c_uid AND (NOT has_a OR (a.status = 'suspended' AND a.user_id IS NULL AND a.max_owner_user_id IS NULL))
     AND (NOT has_ph OR (ph.is_active IS FALSE AND ph.max_user_id IS NULL AND ph.telegram_id IS NULL)) THEN
    RAISE NOTICE '1390: уже сделано — без изменений'; RETURN;
  END IF;

  SELECT count(*) INTO n FROM partners WHERE user_id::text = c_uid AND id::text NOT IN (c_a, c_b);
  IF n > 0 THEN RAISE EXCEPTION '1390: у % ещё карточек: %', c_uid, n; END IF;
  IF has_a AND COALESCE(btrim(a.description), '') <> '' THEN
    RAISE EXCEPTION '1390: у карточки A есть описание — не пустая, стоп'; END IF;

  -- Заглушка: брони, туры, карточки — стоп; прочие строки — в лог.
  IF has_ph THEN
    IF ph.role IS DISTINCT FROM 'tourist' THEN
      RAISE EXCEPTION '1390: у 259dd12b роль %, ждали tourist', ph.role; END IF;
    -- Живые брони туристов — operator_bookings.user_id, живые туры —
    -- operator_tours (bookings/tours — устаревшие таблицы, CLAUDE.md §4):
    -- проверка по устаревшей ответила бы «броней нет» при настоящей брони.
    IF EXISTS (SELECT 1 FROM operator_bookings WHERE user_id::text = c_ph) THEN
      RAISE EXCEPTION '1390: у 259dd12b есть брони — стоп'; END IF;
    IF EXISTS (SELECT 1 FROM operator_tours WHERE created_by::text = c_ph) THEN
      RAISE EXCEPTION '1390: у 259dd12b есть туры — стоп'; END IF;
    IF EXISTS (SELECT 1 FROM partners WHERE user_id::text = c_ph) THEN
      RAISE EXCEPTION '1390: у 259dd12b есть карточки — стоп'; END IF;
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a2.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a2 ON a2.attrelid = c.conrelid AND a2.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND array_length(c.conkey, 1) = 1
       ORDER BY 1, 2
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I::text = $1)', r.tbl, r.col) INTO found_row USING c_ph;
      IF found_row THEN tbls := tbls || r.tbl || '.' || r.col || ' '; END IF;
    END LOOP;
    RAISE NOTICE '1390: строки 259dd12b в таблицах: %', COALESCE(NULLIF(btrim(tbls), ''), 'нет');
  END IF;

  -- MAX: все известные значения совпадают; сами id не печатаются.
  SELECT count(DISTINCT v), min(v) INTO n, mx FROM (VALUES
    (CASE WHEN has_a THEN a.max_owner_user_id END), (b.max_owner_user_id),
    (u.max_user_id), (CASE WHEN has_ph THEN ph.max_user_id END)) s(v) WHERE v IS NOT NULL;
  IF n > 1 THEN RAISE EXCEPTION '1390: MAX ids differ — стоп'; END IF;

  SELECT count(DISTINCT v), min(v) INTO n, tg FROM (VALUES
    (b.telegram_owner_user_id), (CASE WHEN b.telegram_chat_id > 0 THEN b.telegram_chat_id END),
    (u.telegram_id), (CASE WHEN has_ph THEN ph.telegram_id END)) s(v) WHERE v IS NOT NULL;
  IF n > 1 THEN
    RAISE EXCEPTION '1390: Telegram id расходятся: B owner %, B chat %, 4e2ae003 %, 259dd12b % — стоп',
      b.telegram_owner_user_id, b.telegram_chat_id, u.telegram_id, CASE WHEN has_ph THEN ph.telegram_id END;
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE id::text NOT IN (c_uid, c_ph)
              AND ((mx IS NOT NULL AND max_user_id = mx) OR (tg IS NOT NULL AND telegram_id = tg))) THEN
    RAISE EXCEPTION '1390: MAX или Telegram id держит ещё какой-то аккаунт — стоп'; END IF;

  RAISE NOTICE '1390: has_password %', CASE WHEN COALESCE(u.password_hash, '') <> '' THEN 'true' ELSE 'false' END;

  RAISE NOTICE '1390 BACKUP users %', row_to_json(u)::jsonb - 'max_user_id' - 'password_hash' - 'mfa_secret';
  RAISE NOTICE '1390 BACKUP users %', CASE WHEN has_ph THEN row_to_json(ph)::jsonb - 'max_user_id' - 'password_hash' - 'mfa_secret' END;
  RAISE NOTICE '1390 BACKUP partners %', CASE WHEN has_a THEN row_to_json(a)::jsonb - 'max_owner_user_id' END;
  RAISE NOTICE '1390 BACKUP partners %', row_to_json(b)::jsonb - 'max_owner_user_id';

  -- Сначала заглушка отдаёт id, затем их получает 4e2ae003 (уникальные индексы).
  IF has_ph THEN
    UPDATE users SET max_user_id = NULL, telegram_id = NULL, is_active = FALSE, updated_at = NOW()
     WHERE id::text = c_ph;
    DELETE FROM user_sessions WHERE user_id::text = c_ph;
  END IF;
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
      IF n > 0 THEN RAISE NOTICE '1390: с карточки A на B перенесено % строк в %.%', n, r.tbl, r.col; END IF;
    END LOOP;

    UPDATE partners SET status = 'suspended', is_public = FALSE, user_id = NULL,
                        max_owner_user_id = NULL, updated_at = NOW()
     WHERE id::text = c_a;
  END IF;

  UPDATE partners SET user_id = u.id, updated_at = NOW() WHERE id::text = c_b;

  RAISE NOTICE '1390: готово — B владелец 4e2ae003, A suspended, заглушка выключена';
END
$mig$;

COMMIT;
