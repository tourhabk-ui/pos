-- 920_remove_agent_irina_account.sql
--
-- Удаление аккаунта kamlandinfo@yandex.ru (решение владельца 28.08).
--
-- Аккаунт был создан роутом /api/setup/agent-irina с паролем TempPass2026!,
-- захардкоженным в исходнике (P0-находка внешнего security-аудита 28.08,
-- сам роут удалён в #1427). Пароль навсегда остался в git-истории, поэтому
-- аккаунт считается скомпрометированным независимо от того, входил ли по
-- нему кто-нибудь.
--
-- Порядок: сессии отзываются безусловно; партнёрский профиль и сам аккаунт
-- удаляются, а если их держат зависимые строки (FK на users есть у ~30
-- таблиц, и что из этого успело появиться за полтора месяца — неизвестно),
-- удаление честно отступает к обездвиживанию: is_active = false и
-- password_hash, под который не подходит ни один пароль (не bcrypt-формат).
-- Исход каждого шага пишется в лог миграции — молча не проглатывается (§4.0).
--
-- Идемпотентно: повторный прогон на уже удалённом аккаунте — no-op.

DO $$
DECLARE
  v_user_id uuid;
  v_deleted boolean := false;
BEGIN
  SELECT id INTO v_user_id FROM users WHERE email = 'kamlandinfo@yandex.ru';

  IF v_user_id IS NULL THEN
    RAISE NOTICE '[920] kamlandinfo@yandex.ru не найден — уже удалён, делать нечего';
    RETURN;
  END IF;

  -- 1. Сессии — безусловно: с фиксом отзыва (#1429) это мгновенно
  --    обесценивает любой живой токен аккаунта.
  DELETE FROM user_sessions WHERE user_id = v_user_id;

  -- 2. Партнёрский профиль, если появился (создание профиля для агентских
  --    ролей чинилось 24.08 — до этого его не было, после — мог завестись).
  BEGIN
    DELETE FROM partners WHERE user_id = v_user_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE WARNING '[920] партнёрский профиль держат зависимые строки — оставлен, аккаунт будет обездвижен';
  END;

  -- 3. Сам аккаунт.
  BEGIN
    DELETE FROM users WHERE id = v_user_id;
    v_deleted := true;
    RAISE NOTICE '[920] аккаунт kamlandinfo@yandex.ru удалён';
  EXCEPTION WHEN foreign_key_violation THEN
    v_deleted := false;
  END;

  -- 4. Не удалился — обездвиживаем: вход невозможен ни по какому паролю
  --    (строка не является bcrypt-хешем), сессий нет, is_active снят.
  IF NOT v_deleted THEN
    UPDATE users
       SET password_hash = 'DISABLED-security-audit-2026-08-28',
           is_active     = false,
           updated_at    = NOW()
     WHERE id = v_user_id;
    RAISE WARNING '[920] аккаунт держат зависимые строки — не удалён, а обездвижен (пароль сломан, сессии отозваны)';
  END IF;
END $$;
