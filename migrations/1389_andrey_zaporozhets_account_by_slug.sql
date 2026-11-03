-- Migration 1389: привязка аккаунта к карточке гида «Андрей Запорожец» — по слагу (03.11)
--
-- 1388 своей работы не сделала: на проде ДВЕ карточки «Андрей Запорожец»
-- (проверка владельца в админке 03.11). Настоящая — слаг andrey-zaporozhets,
-- «Верифицирован», публичная, MAX+TG, согласие с 29.10, аккаунта нет. Пустая —
-- из регистрации zap.andy@gmail.com, «Ожидает», скрыта, MAX подключён. 1388
-- искала карточку по имени и проверяла пустоту новой по всем ссылкам — на
-- одном из этих шагов и остановилась.
--
-- Здесь цели заданы точно: настоящая — по слагу, пустая — по почте
-- zap.andy@gmail.com (аккаунт или заявка) и profile_status 'pending'.
-- Одной транзакцией: бэкап строк в лог (RAISE NOTICE '1389 BACKUP …'),
-- аккаунт zap.andy@gmail.com — владелец настоящей карточки, MAX/TG id —
-- на этот аккаунт, пустая карточка — status 'suspended', скрыта, без
-- аккаунта (не удаляется). Неоднозначность — RAISE EXCEPTION, откат.
-- Повторный запуск — без изменений.

BEGIN;

DO $mig$
DECLARE
  v_user users%ROWTYPE;
  v_real partners%ROWTYPE;
  v_new  partners%ROWTYPE;
  n INT;
  r RECORD;
  found_row BOOLEAN;
  mx BIGINT;
  tg BIGINT;
  holder RECORD;
BEGIN
  SELECT count(*) INTO n FROM partners WHERE slug = 'andrey-zaporozhets';
  IF n = 0 THEN RAISE NOTICE '1389: карточки andrey-zaporozhets нет — пропуск'; RETURN; END IF;
  IF n > 1 THEN RAISE EXCEPTION '1389: карточек со слагом andrey-zaporozhets: %', n; END IF;
  SELECT * INTO v_real FROM partners WHERE slug = 'andrey-zaporozhets' FOR UPDATE;
  IF v_real.category IS DISTINCT FROM 'guide' THEN
    RAISE EXCEPTION '1389: andrey-zaporozhets — не гид (%)', v_real.category; END IF;

  -- Пустая карточка из регистрации: почта zap.andy@gmail.com — у аккаунта
  -- карточки или в заявке (админка показывает любую из двух), «Ожидает».
  SELECT count(*) INTO n FROM partners p
   WHERE p.id::text <> v_real.id::text AND p.category = 'guide'
     AND (p.profile_status = 'pending' OR p.status = 'pending')
     AND (EXISTS (SELECT 1 FROM users u WHERE u.id::text = p.user_id::text
                   AND lower(btrim(u.email)) = 'zap.andy@gmail.com')
          OR EXISTS (SELECT 1 FROM operator_applications oa
                      WHERE oa.partner_id::text = p.id::text
                        AND lower(btrim(oa.contact_email)) = 'zap.andy@gmail.com'));
  IF n > 1 THEN RAISE EXCEPTION '1389: пустых карточек zap.andy@gmail.com: %', n; END IF;
  IF n = 1 THEN
    SELECT p.* INTO v_new FROM partners p
     WHERE p.id::text <> v_real.id::text AND p.category = 'guide'
       AND (p.profile_status = 'pending' OR p.status = 'pending')
       AND (EXISTS (SELECT 1 FROM users u WHERE u.id::text = p.user_id::text
                     AND lower(btrim(u.email)) = 'zap.andy@gmail.com')
            OR EXISTS (SELECT 1 FROM operator_applications oa
                        WHERE oa.partner_id::text = p.id::text
                          AND lower(btrim(oa.contact_email)) = 'zap.andy@gmail.com'))
     FOR UPDATE OF p;
  END IF;

  -- Аккаунт: users.email = zap.andy@gmail.com и/или аккаунт пустой карточки.
  -- Должен получиться ровно один.
  SELECT count(DISTINCT id) INTO n FROM users
   WHERE lower(btrim(email)) = 'zap.andy@gmail.com'
      OR (v_new.user_id IS NOT NULL AND id::text = v_new.user_id::text);
  IF n = 0 THEN
    IF v_real.user_id IS NULL THEN
      RAISE WARNING '1389: аккаунта zap.andy@gmail.com нет (ни по почте, ни у пустой карточки) — ничего не тронуто';
    END IF;
    RETURN;
  END IF;
  IF n > 1 THEN RAISE EXCEPTION '1389: кандидатов в аккаунт: % (почта и аккаунт пустой карточки расходятся)', n; END IF;
  SELECT * INTO v_user FROM users
   WHERE lower(btrim(email)) = 'zap.andy@gmail.com'
      OR (v_new.user_id IS NOT NULL AND id::text = v_new.user_id::text)
   FOR UPDATE;

  IF v_real.user_id IS NOT NULL THEN
    IF v_real.user_id::text = v_user.id::text THEN
      RAISE NOTICE '1389: карточка % уже привязана к % — без изменений', v_real.id, v_user.id; RETURN;
    END IF;
    RAISE EXCEPTION '1389: у карточки andrey-zaporozhets другой аккаунт %', v_real.user_id;
  END IF;

  IF v_new.id IS NOT NULL THEN
    IF v_new.user_id IS NOT NULL AND v_new.user_id::text <> v_user.id::text THEN
      RAISE EXCEPTION '1389: пустая карточка % принадлежит другому аккаунту %', v_new.id, v_new.user_id; END IF;
    IF COALESCE(btrim(v_new.description), '') <> '' THEN
      RAISE EXCEPTION '1389: у карточки % есть описание — не пустая, стоп', v_new.id; END IF;
    -- Ссылки на пустую карточку: служебные строки регистрации допустимы,
    -- туры, заявки, брони, платежи и прочее — стоп.
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'partners'::regclass
         AND array_length(c.conkey, 1) = 1
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I::text = $1)', r.tbl, r.col)
        INTO found_row USING v_new.id::text;
      IF found_row THEN
        IF r.tbl IN ('operator_applications', 'operator_settings', 'operator_stats_cache', 'operator_ai_config') THEN
          RAISE NOTICE '1389: у пустой карточки % есть служебная строка в % — допустимо', v_new.id, r.tbl;
        ELSE
          RAISE EXCEPTION '1389: у пустой карточки % есть данные в % — стоп', v_new.id, r.tbl;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Других карточек у аккаунта быть не должно.
  SELECT count(*) INTO n FROM partners
   WHERE user_id::text = v_user.id::text AND id::text <> COALESCE(v_new.id::text, '');
  IF n > 0 THEN RAISE EXCEPTION '1389: у аккаунта % ещё карточек: %', v_user.id, n; END IF;

  -- MAX/TG id: с настоящей карточки, MAX — при её отсутствии с пустой.
  mx := COALESCE(v_real.max_owner_user_id, v_new.max_owner_user_id);
  IF v_real.max_owner_user_id IS NOT NULL AND v_new.max_owner_user_id IS NOT NULL
     AND v_real.max_owner_user_id <> v_new.max_owner_user_id THEN
    RAISE EXCEPTION '1389: у карточек разные MAX-владельцы % и %', v_real.max_owner_user_id, v_new.max_owner_user_id; END IF;
  tg := COALESCE(v_real.telegram_owner_user_id,
                 CASE WHEN v_real.telegram_chat_id > 0 THEN v_real.telegram_chat_id END);
  IF mx IS NOT NULL AND v_user.max_user_id IS NOT NULL AND v_user.max_user_id <> mx THEN
    RAISE EXCEPTION '1389: у аккаунта другой MAX id %', v_user.max_user_id; END IF;
  IF tg IS NOT NULL AND v_user.telegram_id IS NOT NULL AND v_user.telegram_id <> tg THEN
    RAISE EXCEPTION '1389: у аккаунта другой Telegram id %', v_user.telegram_id; END IF;

  -- Бэкап до изменений.
  RAISE NOTICE '1389 BACKUP users %', (SELECT row_to_json(u) FROM users u WHERE u.id::text = v_user.id::text);
  RAISE NOTICE '1389 BACKUP partners %', (SELECT row_to_json(p) FROM partners p WHERE p.id::text = v_real.id::text);
  IF v_new.id IS NOT NULL THEN
    RAISE NOTICE '1389 BACKUP partners %', (SELECT row_to_json(p) FROM partners p WHERE p.id::text = v_new.id::text);
  END IF;

  -- Чужие держатели id: пустой дубль — снять и выключить; с данными — стоп.
  FOR holder IN
    SELECT id FROM users
     WHERE id::text <> v_user.id::text
       AND ((mx IS NOT NULL AND max_user_id = mx) OR (tg IS NOT NULL AND telegram_id = tg))
  LOOP
    IF NOT vedar_messenger_placeholder_empty(holder.id) THEN
      RAISE EXCEPTION '1389: id MAX/TG держит аккаунт % с данными — стоп', holder.id; END IF;
    RAISE NOTICE '1389 BACKUP users %', (SELECT row_to_json(u) FROM users u WHERE u.id::text = holder.id::text);
    UPDATE users SET
      max_user_id = CASE WHEN max_user_id = mx THEN NULL ELSE max_user_id END,
      telegram_id = CASE WHEN telegram_id = tg THEN NULL ELSE telegram_id END,
      is_active = FALSE
     WHERE id::text = holder.id::text;
    DELETE FROM user_sessions WHERE user_id::text = holder.id::text;
    RAISE NOTICE '1389: пустой дубль % выключен', holder.id;
  END LOOP;

  IF v_new.id IS NOT NULL THEN
    UPDATE partners SET status = 'suspended', is_public = FALSE, user_id = NULL, updated_at = NOW()
     WHERE id::text = v_new.id::text;
  END IF;
  UPDATE partners SET user_id = v_user.id, updated_at = NOW() WHERE id::text = v_real.id::text;
  UPDATE users SET
    max_user_id = COALESCE(mx, max_user_id),
    telegram_id = COALESCE(tg, telegram_id),
    role = CASE WHEN role IN ('tourist', 'guide') THEN 'guide' ELSE role END,
    updated_at = NOW()
   WHERE id::text = v_user.id::text;

  RAISE NOTICE '1389: карточка % → аккаунт %; MAX % TG %; пустая % suspended',
    v_real.id, v_user.id, mx, tg, v_new.id;
END
$mig$;

COMMIT;
