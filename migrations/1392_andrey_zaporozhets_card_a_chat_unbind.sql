-- Migration 1392: пустая карточка A Андрея Запорожца — снять привязку чатов бота (04.11)
--
-- После 1391 админка (04.11, владелец) показывает у пустой карточки A
-- d9d1d230-4f18-4917-84f1-59b8fafb11c2 «MAX подключён». Это не колонка входа
-- (max_owner_user_id — её 1391 обнулила), а partners.max_chat_id: чат бота,
-- куда уходят заявки и где открывается кабинет в чате (lib/kuzmich/operator-chat,
-- findPartnerByChat — по чату берётся ОДНА карточка, старейшая по created_at).
-- На вход через сайт она не влияет (vedar_messenger_owner читает только
-- max_owner_user_id у карточек с аккаунтом), но пока у A и у настоящей
-- карточки B один и тот же чат, кабинет в MAX и Telegram может открыться на
-- выключенной A, если она старше. Привязку чата у A снимаем; у B — не трогаем.
--
-- Только карточка A, только пока она suspended и без аккаунта (так оставила
-- 1391); иначе — пропуск с NOTICE. Id чатов не печатаются. Повтор — без изменений.

BEGIN;

DO $mig$
DECLARE
  c_a CONSTANT TEXT := 'd9d1d230-4f18-4917-84f1-59b8fafb11c2';
  a partners%ROWTYPE;
BEGIN
  SELECT * INTO a FROM partners WHERE id::text = c_a FOR UPDATE;
  IF NOT FOUND THEN RAISE NOTICE '1392: карточки % нет — пропуск', c_a; RETURN; END IF;
  IF a.status IS DISTINCT FROM 'suspended' OR a.user_id IS NOT NULL THEN
    RAISE NOTICE '1392: карточка % не в состоянии после 1391 (status %, аккаунт %) — пропуск',
      c_a, a.status, CASE WHEN a.user_id IS NULL THEN 'нет' ELSE 'есть' END;
    RETURN;
  END IF;
  IF a.max_chat_id IS NULL AND a.telegram_chat_id IS NULL THEN
    RAISE NOTICE '1392: уже сделано — без изменений'; RETURN;
  END IF;
  RAISE NOTICE '1392: у карточки A снята привязка чатов: MAX %, Telegram %',
    CASE WHEN a.max_chat_id IS NULL THEN 'не было' ELSE 'снят' END,
    CASE WHEN a.telegram_chat_id IS NULL THEN 'не было' ELSE 'снят' END;
  UPDATE partners SET max_chat_id = NULL, telegram_chat_id = NULL, updated_at = NOW()
   WHERE id::text = c_a;
END
$mig$;

COMMIT;
