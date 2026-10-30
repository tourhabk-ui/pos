-- Migration 1357: правка своего тура из чата кабинета — черновик до кнопки «Сохранить»
-- Created: 2026-10-30
--
-- Слово владельца 30.10: «гид должен полностью управлять своей ролью из
-- MAX». Повод — гид Андрей Запорожец в тот же день правил тексты своих туров
-- в Google-документах, а разработчик переносил их миграцией 1356: правки
-- текстов тура у гида не было нигде (PATCH тура открыт только кабинету
-- оператора).
--
-- Гид пишет помощнику «Горелый: описание: …», «Горелый: цена 16000»,
-- «Толбачик: что взять: …» — фразу разбирают правила (lib/guides/tour-edit),
-- не модель. Ответ — предпросмотр «было → станет» и кнопки «Сохранить» /
-- «Отмена». Без кнопки в тур не пишется ничего: до нажатия правка живёт
-- здесь, черновиком. Модерации нет — как и у правки оператора на сайте:
-- тур гида, гид и решает (владелец: «полностью управлять»).
--
-- Строка — один черновик:
--   · tour_id NULL — тур ещё выбирается кнопкой из candidate_ids («Курильское»
--     — два тура);
--   · new_value — что станет, live_value — что было, когда гид смотрел
--     предпросмотр. «Сохранить» сверяет live_value с тем, что в туре сейчас:
--     тур поменяли на сайте после предпросмотра — не сохраняется, гид видит
--     новый предпросмотр. Пустое поле — JSON null, а не SQL NULL;
--   · один pending на чат: новый черновик того же чата снимает прежний
--     (superseded), и старая кнопка «Сохранить» больше не пишет;
--   · срок — expires_at (два часа).
-- Персональных данных нет: текст тура, цена, номер тура.
--
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS tour_chat_edits (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  channel        TEXT        NOT NULL,
  chat_id        BIGINT      NOT NULL,
  tour_id        BIGINT      REFERENCES operator_tours(id) ON DELETE CASCADE,
  candidate_ids  BIGINT[]    NOT NULL DEFAULT '{}',
  field          TEXT        NOT NULL,
  new_value      JSONB       NOT NULL,
  live_value     JSONB,
  status         TEXT        NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  decided_at     TIMESTAMPTZ,
  CONSTRAINT tour_chat_edits_channel_check CHECK (channel IN ('max', 'telegram')),
  CONSTRAINT tour_chat_edits_field_check CHECK (field IN (
    'title', 'short_description', 'description', 'program', 'included', 'not_included',
    'what_to_bring', 'safety_notes', 'base_price')),
  CONSTRAINT tour_chat_edits_status_check CHECK (status IN ('pending', 'saved', 'cancelled', 'superseded')),
  CONSTRAINT tour_chat_edits_decided_check CHECK ((decided_at IS NULL) = (status = 'pending')),
  CONSTRAINT tour_chat_edits_saved_tour_check CHECK (status <> 'saved' OR tour_id IS NOT NULL),
  CONSTRAINT tour_chat_edits_live_check CHECK (tour_id IS NULL OR live_value IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS tour_chat_edits_one_pending_per_chat
  ON tour_chat_edits (channel, chat_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS tour_chat_edits_partner_idx
  ON tour_chat_edits (partner_id, created_at DESC);

COMMENT ON TABLE tour_chat_edits IS
  'Правка своего тура из чата кабинета (1357): черновик до кнопки «Сохранить». Один pending на чат, срок два часа; «Сохранить» сверяет live_value с туром и пишет общей функцией lib/tours/tour-write.';

COMMIT;
