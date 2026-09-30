-- 1118: контроль выхода из чата Кузьмича.
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- 30.09 владелец: «зачем что-то в наше время заполнять вручную, если можно
-- делать это из чата?» Человек пишет Кузьмичу в MAX «еду на Чёртов мост, если
-- задержусь — сообщите маме», и контроль ставится без формы. Правила слоя —
-- docs/safety/WATCH_MANIFEST.md; решение «включить» принимает человек явным
-- «да» на итог, проверяет его код (правило 3).
--
-- ── Что заводится ─────────────────────────────────────────────────────────
--
-- route_registrations:
--   source               — откуда контроль: form (страница /register) или max
--                          (чат Кузьмича в MAX). Старые строки — form: до этой
--                          миграции другого пути не было. Telegram здесь нет
--                          намеренно: контроль без телефонов не работает, а
--                          политика конфиденциальности (разд. 5) обещает, что
--                          персональных данных в Telegram нет.
--   tourist_chat_channel — канал к самому туристу ('max'), NULL у формы;
--   tourist_chat_id      — id чата в этом канале. Нужен сторожу, чтобы первым
--                          будить самого человека (правило 4), и чату — чтобы
--                          «вернулся» закрывал именно его контроль.
--   closed_by            — кто закрыл: link (страница /return), chat (слово
--                          в чате). NULL у закрытых до этой миграции: кто
--                          закрыл, не записано, догадываться нельзя.
--   closed_reason        — почему: returned («вернулся», страница /return)
--                          или cancelled («отменить контроль»). Отбой тем,
--                          кого встревожили, говорит правду по этой колонке:
--                          снятый контроль — не «вернулся, искать не нужно».
--                          NULL — причина не записана, и весть так и говорит.
--   ladder_reset_at      — когда турист назначил НОВЫЙ срок («+2 ч», «до
--                          21:00»). Сторож считает пройденными только шаги,
--                          отправленные после этой минуты: продлённый контроль
--                          снова начинается с вопроса самому туристу, а не
--                          сразу с контакта.
--
-- trip_watch_flow — черновик контроля в чате, пока человек не сказал «да».
-- Ключ (channel, chat_id): у одного чата один черновик.
--
-- IDEMPOTENT

BEGIN;

ALTER TABLE route_registrations
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'form',
  ADD COLUMN IF NOT EXISTS tourist_chat_channel TEXT,
  ADD COLUMN IF NOT EXISTS tourist_chat_id BIGINT,
  ADD COLUMN IF NOT EXISTS closed_by TEXT,
  ADD COLUMN IF NOT EXISTS closed_reason TEXT,
  ADD COLUMN IF NOT EXISTS ladder_reset_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_registrations_source_check') THEN
    ALTER TABLE route_registrations
      ADD CONSTRAINT route_registrations_source_check
      CHECK (source IN ('form', 'max'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_registrations_tourist_chat_check') THEN
    ALTER TABLE route_registrations
      ADD CONSTRAINT route_registrations_tourist_chat_check
      CHECK ((tourist_chat_channel IS NULL AND tourist_chat_id IS NULL)
          OR (tourist_chat_channel = 'max' AND tourist_chat_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_registrations_closed_by_check') THEN
    ALTER TABLE route_registrations
      ADD CONSTRAINT route_registrations_closed_by_check
      CHECK (closed_by IS NULL OR closed_by IN ('link', 'chat'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_registrations_closed_reason_check') THEN
    ALTER TABLE route_registrations
      ADD CONSTRAINT route_registrations_closed_reason_check
      CHECK (closed_reason IS NULL OR closed_reason IN ('returned', 'cancelled'));
  END IF;
END $$;

-- Открытый контроль этого чата — «вернулся» ищет его здесь.
CREATE INDEX IF NOT EXISTS idx_route_registrations_tourist_chat_open
  ON route_registrations (tourist_chat_channel, tourist_chat_id)
  WHERE completed_at IS NULL AND tourist_chat_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trip_watch_flow (
  channel    TEXT        NOT NULL CHECK (channel = 'max'),
  chat_id    BIGINT      NOT NULL,
  state      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, chat_id)
);

COMMENT ON TABLE trip_watch_flow IS
  'Черновик контроля выхода в чате Кузьмича до явного «да» человека. '
  'Живёт 30 минут; контроль создаётся только из подтверждённого черновика '
  '(docs/safety/WATCH_MANIFEST.md, правило 3).';

COMMIT;
