-- Migration 1390: аккаунт Андрея Запорожца — по явным id (04.11, замена 1389)
--
-- Факты из админки 03–04.11:
--   259dd12b-7025-430e-9baa-254a08a37f39 — заглушка входа через Telegram
--     («Андрей», tg_221997120@telegram.local, tourist, 0 броней). Держит
--     MAX/TG id Андрея, из-за этого 1389 остановилась.
--   4e2ae003-d54e-4a5d-9604-30d4e948ff09 — настоящий аккаунт zap.andy@gmail.com.
--   Настоящая карточка — слаг andrey-zaporozhets; пустая — «Ожидает»,
--   почта zap.andy@gmail.com (аккаунт или заявка).
-- Одной транзакцией: бэкап в лог, MAX/TG id 259dd12b → 4e2ae003, 259dd12b
-- выключается (is_active=false, сессии удаляются, строка остаётся), 4e2ae003 —
-- владелец andrey-zaporozhets, пустая карточка — suspended, скрыта.
-- Стоп (откат), если у 259dd12b есть брони, туры или карточки, если у
-- настоящей карточки другой владелец или пустых карточек больше одной.
-- Повторный запуск ничего не меняет.

BEGIN;

DO $mig$
DECLARE
  v_ph   CONSTANT TEXT := '259dd12b-7025-430e-9baa-254a08a37f39';
  v_uid  CONSTANT TEXT := '4e2ae003-d54e-4a5d-9604-30d4e948ff09';
  v_ph_row users%ROWTYPE;
  v_user users%ROWTYPE;
  v_real partners%ROWTYPE;
  v_new  partners%ROWTYPE;
  n INT;
  mx BIGINT;
  tg BIGINT;
  r RECORD;
  found_row BOOLEAN;
BEGIN
  SELECT * INTO v_user FROM users WHERE id::text = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE NOTICE '1390: аккаунта % нет — пропуск', v_uid; RETURN; END IF;
  IF lower(btrim(COALESCE(v_user.email, ''))) <> 'zap.andy@gmail.com' THEN
    RAISE EXCEPTION '1390: у % почта %, а не zap.andy@gmail.com — стоп', v_uid, v_user.email; END IF;

  SELECT count(*) INTO n FROM partners WHERE slug = 'andrey-zaporozhets';
  IF n <> 1 THEN RAISE EXCEPTION '1390: карточек andrey-zaporozhets: %', n; END IF;
  SELECT * INTO v_real FROM partners WHERE slug = 'andrey-zaporozhets' FOR UPDATE;
  IF v_real.user_id IS NOT NULL AND v_real.user_id::text <> v_uid THEN
    RAISE EXCEPTION '1390: у andrey-zaporozhets другой владелец %', v_real.user_id; END IF;

  -- Пустая карточка «Ожидает» с почтой zap.andy@gmail.com (0 — уже обработана).
  SELECT count(*) INTO n FROM partners p
   WHERE p.id::text <> v_real.id::text
     AND (p.profile_status = 'pending' OR p.status = 'pending')
     AND (p.user_id::text = v_uid
          OR EXISTS (SELECT 1 FROM operator_applications oa
                      WHERE oa.partner_id::text = p.id::text
                        AND lower(btrim(oa.contact_email)) = 'zap.andy@gmail.com'));
  IF n > 1 THEN RAISE EXCEPTION '1390: пустых карточек zap.andy@gmail.com: %', n; END IF;
  IF n = 1 THEN
    SELECT p.* INTO v_new FROM partners p
     WHERE p.id::text <> v_real.id::text
       AND (p.profile_status = 'pending' OR p.status = 'pending')
       AND (p.user_id::text = v_uid
            OR EXISTS (SELECT 1 FROM operator_applications oa
                        WHERE oa.partner_id::text = p.id::text
                          AND lower(btrim(oa.contact_email)) = 'zap.andy@gmail.com'))
     FOR UPDATE OF p;
    IF v_new.user_id IS NOT NULL AND v_new.user_id::text <> v_uid THEN
      RAISE EXCEPTION '1390: пустая карточка % у другого аккаунта %', v_new.id, v_new.user_id; END IF;
    IF COALESCE(btrim(v_new.description), '') <> '' THEN
      RAISE EXCEPTION '1390: у карточки % есть описание — не пустая', v_new.id; END IF;
    IF EXISTS (SELECT 1 FROM tours t WHERE t.operator_id::text = v_new.id::text) THEN
      RAISE EXCEPTION '1390: у пустой карточки % есть туры', v_new.id; END IF;
    IF EXISTS (SELECT 1 FROM bookings b JOIN tours t ON t.id::text = b.tour_id::text WHERE t.operator_id::text = v_new.id::text) THEN
      RAISE EXCEPTION '1390: у пустой карточки % есть брони', v_new.id; END IF;
  END IF;

  -- Других карточек у 4e2ae003 быть не должно.
  SELECT count(*) INTO n FROM partners
   WHERE user_id::text = v_uid AND id::text <> v_real.id::text
     AND id::text <> COALESCE(v_new.id::text, '');
  IF n > 0 THEN RAISE EXCEPTION '1390: у % ещё карточек: %', v_uid, n; END IF;

  -- Заглушка 259dd12b: брони, туры, карточки — стоп; прочее — в лог.
  SELECT * INTO v_ph_row FROM users WHERE id::text = v_ph FOR UPDATE;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM bookings WHERE user_id::text = v_ph) THEN
      RAISE EXCEPTION '1390: у % есть брони — стоп', v_ph; END IF;
    IF EXISTS (SELECT 1 FROM tours WHERE operator_id::text = v_ph OR guide_id::text = v_ph) THEN
      RAISE EXCEPTION '1390: у % есть туры — стоп', v_ph; END IF;
    IF EXISTS (SELECT 1 FROM partners WHERE user_id::text = v_ph) THEN
      RAISE EXCEPTION '1390: у % есть карточки — стоп', v_ph; END IF;
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
         AND array_length(c.conkey, 1) = 1
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I::text = $1)', r.tbl, r.col)
        INTO found_row USING v_ph;
      IF found_row THEN
        RAISE NOTICE '1390: у % есть строки в %.% — не бизнес-данные, остаются', v_ph, r.tbl, r.col;
      END IF;
    END LOOP;
  END IF;

  mx := COALESCE(v_ph_row.max_user_id, v_real.max_owner_user_id, v_new.max_owner_user_id);
  tg := COALESCE(v_ph_row.telegram_id, v_real.telegram_owner_user_id,
                 CASE WHEN v_real.telegram_chat_id > 0 THEN v_real.telegram_chat_id END);
  IF mx IS NOT NULL AND v_user.max_user_id IS NOT NULL AND v_user.max_user_id <> mx THEN
    RAISE EXCEPTION '1390: у % другой MAX id %', v_uid, v_user.max_user_id; END IF;
  IF tg IS NOT NULL AND v_user.telegram_id IS NOT NULL AND v_user.telegram_id <> tg THEN
    RAISE EXCEPTION '1390: у % другой Telegram id %', v_uid, v_user.telegram_id; END IF;
  -- Иных держателей этих id (кроме заглушки) быть не должно.
  IF EXISTS (SELECT 1 FROM users WHERE id::text NOT IN (v_ph, v_uid)
              AND ((mx IS NOT NULL AND max_user_id = mx) OR (tg IS NOT NULL AND telegram_id = tg))) THEN
    RAISE EXCEPTION '1390: MAX/TG id держит ещё какой-то аккаунт — стоп'; END IF;

  -- Идемпотентность.
  IF v_real.user_id::text = v_uid AND v_new.id IS NULL
     AND v_user.max_user_id IS NOT DISTINCT FROM mx AND v_user.telegram_id IS NOT DISTINCT FROM tg
     AND (v_ph_row.id IS NULL OR (v_ph_row.is_active IS FALSE
          AND v_ph_row.max_user_id IS NULL AND v_ph_row.telegram_id IS NULL)) THEN
    RAISE NOTICE '1390: уже сделано — без изменений'; RETURN;
  END IF;

  RAISE NOTICE '1390 BACKUP users %', (SELECT row_to_json(u) FROM users u WHERE u.id::text = v_uid);
  RAISE NOTICE '1390 BACKUP users %', (SELECT row_to_json(u) FROM users u WHERE u.id::text = v_ph);
  RAISE NOTICE '1390 BACKUP partners %', (SELECT row_to_json(p) FROM partners p WHERE p.id::text = v_real.id::text);
  IF v_new.id IS NOT NULL THEN
    RAISE NOTICE '1390 BACKUP partners %', (SELECT row_to_json(p) FROM partners p WHERE p.id::text = v_new.id::text);
  END IF;

  IF v_ph_row.id IS NOT NULL THEN
    UPDATE users SET max_user_id = NULL, telegram_id = NULL, is_active = FALSE WHERE id::text = v_ph;
    DELETE FROM user_sessions WHERE user_id::text = v_ph;
  END IF;

  UPDATE users SET
    max_user_id = COALESCE(mx, max_user_id),
    telegram_id = COALESCE(tg, telegram_id),
    role = CASE WHEN role IN ('tourist', 'guide') THEN 'guide' ELSE role END
   WHERE id::text = v_uid;

  IF v_new.id IS NOT NULL THEN
    UPDATE partners SET status = 'suspended', is_public = FALSE, user_id = NULL
     WHERE id::text = v_new.id::text;
  END IF;

  UPDATE partners SET user_id = v_uid::uuid WHERE id::text = v_real.id::text;

  RAISE NOTICE '1390: готово — % владелец %, MAX %, TG %, пустая карточка % suspended, заглушка % выключена',
    v_uid, v_real.id, mx, tg, v_new.id, v_ph;
END
$mig$;

COMMIT;
