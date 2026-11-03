-- Migration 1388: разовая привязка аккаунта к карточке гида «Андрей Запорожец» (04.11)
--
-- Решение владельца 04.11 («да делай»). Карточка гида заведена командой,
-- аккаунта у неё нет (partners.user_id NULL), MAX/Telegram подключены к
-- карточке. Человек зарегистрировался заново (zap.andy@gmail.com) и получил
-- пустую карточку гида. Здесь, одной транзакцией:
--   1) бэкап затронутых строк в _backup_1388_* (и RAISE NOTICE);
--   2) карточка получает владельца — аккаунт zap.andy@gmail.com;
--   3) MAX/Telegram id владельца карточки переносятся на этот аккаунт;
--      если id держит пустой турист-дубль — у дубля id снимается, дубль
--      выключается; если держит кто-то с данными — СТОП;
--   4) пустая карточка из регистрации — status 'suspended', user_id NULL
--      (не удаляется).
-- Любая неоднозначность (не одна карточка/аккаунт, у новой карточки есть
-- данные) — RAISE EXCEPTION, вся транзакция откатывается. Уже сделано —
-- выходит без изменений (идемпотентно).

BEGIN;

CREATE TABLE IF NOT EXISTS _backup_1388_users AS SELECT * FROM users WITH NO DATA;
CREATE TABLE IF NOT EXISTS _backup_1388_partners AS SELECT * FROM partners WITH NO DATA;

DO $mig$
DECLARE
  v_user users%ROWTYPE;
  v_card partners%ROWTYPE;
  v_new partners%ROWTYPE;
  n INT;
  r RECORD;
  found_row BOOLEAN;
  tg BIGINT;
  mx BIGINT;
  holder RECORD;
BEGIN
  SELECT count(*) INTO n FROM users WHERE lower(email) = 'zap.andy@gmail.com';
  IF n = 0 THEN RAISE NOTICE '1388: аккаунта zap.andy@gmail.com нет — пропуск'; RETURN; END IF;
  IF n > 1 THEN RAISE EXCEPTION '1388: аккаунтов zap.andy@gmail.com: %', n; END IF;
  SELECT * INTO v_user FROM users WHERE lower(email) = 'zap.andy@gmail.com' FOR UPDATE;

  -- Уже сделано?
  IF EXISTS (SELECT 1 FROM partners WHERE user_id::text = v_user.id::text
              AND name ILIKE '%Запорожец%' AND COALESCE(status,'') <> 'suspended') THEN
    RAISE NOTICE '1388: карточка уже привязана к % — без изменений', v_user.id; RETURN;
  END IF;

  SELECT count(*) INTO n FROM partners
   WHERE user_id IS NULL AND category = 'guide' AND name ILIKE '%Андрей%Запорожец%';
  IF n <> 1 THEN RAISE EXCEPTION '1388: карточек «Андрей Запорожец» без аккаунта: % (нужна одна)', n; END IF;
  SELECT * INTO v_card FROM partners
   WHERE user_id IS NULL AND category = 'guide' AND name ILIKE '%Андрей%Запорожец%' FOR UPDATE;

  -- Пустая карточка из регистрации: ровно одна (или ноль), без данных.
  SELECT count(*) INTO n FROM partners WHERE user_id::text = v_user.id::text;
  IF n > 1 THEN RAISE EXCEPTION '1388: у % карточек: %', v_user.id, n; END IF;
  IF n = 1 THEN
    SELECT * INTO v_new FROM partners WHERE user_id::text = v_user.id::text FOR UPDATE;
    FOR r IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'partners'::regclass
         AND array_length(c.conkey, 1) = 1
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', r.tbl, r.col)
        INTO found_row USING v_new.id;
      IF found_row THEN
        RAISE EXCEPTION '1388: у новой карточки % есть данные в % — стоп', v_new.id, r.tbl;
      END IF;
    END LOOP;
  END IF;

  -- Бэкап до изменений.
  INSERT INTO _backup_1388_users SELECT * FROM users WHERE id::text = v_user.id::text;
  INSERT INTO _backup_1388_partners SELECT * FROM partners WHERE id::text = v_card.id::text;
  IF v_new.id IS NOT NULL THEN
    INSERT INTO _backup_1388_partners SELECT * FROM partners WHERE id::text = v_new.id::text;
  END IF;

  mx := v_card.max_owner_user_id;
  tg := COALESCE(v_card.telegram_owner_user_id,
                 CASE WHEN v_card.telegram_chat_id > 0 THEN v_card.telegram_chat_id END);

  -- Владельцы id в users: пустой турист-дубль — снять; с данными — стоп.
  FOR holder IN
    SELECT id, max_user_id, telegram_id FROM users
     WHERE id::text <> v_user.id::text
       AND ((mx IS NOT NULL AND max_user_id = mx) OR (tg IS NOT NULL AND telegram_id = tg))
  LOOP
    IF NOT vedar_messenger_placeholder_empty(holder.id) THEN
      RAISE EXCEPTION '1388: id MAX/TG держит аккаунт % с данными — стоп', holder.id;
    END IF;
    INSERT INTO _backup_1388_users SELECT * FROM users WHERE id = holder.id;
    UPDATE users SET
      max_user_id = CASE WHEN max_user_id = mx THEN NULL ELSE max_user_id END,
      telegram_id = CASE WHEN telegram_id = tg THEN NULL ELSE telegram_id END,
      is_active = FALSE
     WHERE id = holder.id;
    DELETE FROM user_sessions WHERE user_id = holder.id;
    RAISE NOTICE '1388: пустой дубль % выключен', holder.id;
  END LOOP;

  IF mx IS NOT NULL AND v_user.max_user_id IS NOT NULL AND v_user.max_user_id <> mx THEN
    RAISE EXCEPTION '1388: у аккаунта уже другой MAX id'; END IF;
  IF tg IS NOT NULL AND v_user.telegram_id IS NOT NULL AND v_user.telegram_id <> tg THEN
    RAISE EXCEPTION '1388: у аккаунта уже другой Telegram id'; END IF;

  IF v_new.id IS NOT NULL THEN
    UPDATE partners SET status = 'suspended', user_id = NULL, updated_at = NOW() WHERE id = v_new.id;
  END IF;
  UPDATE partners SET user_id = v_user.id, updated_at = NOW() WHERE id = v_card.id;
  UPDATE users SET
    max_user_id = COALESCE(mx, max_user_id),
    telegram_id = COALESCE(tg, telegram_id),
    role = CASE WHEN role IN ('tourist', 'guide') THEN 'guide' ELSE role END,
    updated_at = NOW()
   WHERE id = v_user.id;

  RAISE NOTICE '1388: карточка % → аккаунт %; MAX % TG %; пустая карточка % suspended',
    v_card.id, v_user.id, mx, tg, v_new.id;
  IF mx IS NULL THEN
    RAISE NOTICE '1388: у карточки нет max_owner_user_id — MAX id не перенесён (вход через MAX свяжется после op_-ссылки)';
  END IF;
END
$mig$;

COMMIT;
