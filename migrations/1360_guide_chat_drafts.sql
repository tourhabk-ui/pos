-- Migration 1360: ответ на отзыв и профиль гида из чата кабинета — черновик до кнопки
-- Created: 2026-10-30
--
-- Слово владельца 30.10: «гид должен полностью управлять своей ролью из
-- MAX». Этап 1 (1357, tour_chat_edits) дал правку своего тура; этап 2 — ответ
-- на отзыв туриста и «о себе» профиля. Та же форма: гид пишет текст, бот
-- показывает «было → станет», и пишется только кнопкой («Опубликовать»,
-- «Удалить», «Сохранить») — общей функцией сайта (lib/guides/review-reply,
-- lib/guides/profile-write). Модель в этих строках не участвует.
--
-- Соседняя таблица, а не обобщение 1357: у правки тура свои колонки (тур,
-- кандидаты, белый список полей тура), и смешивать в одной строке тур,
-- отзыв и профиль значило бы снять с неё проверки, которые держит база.
--
-- Строка — один черновик:
--   · kind: reply — ответ на отзыв (новый или изменённый), reply_delete —
--     убрать ответ, profile — поле профиля (field);
--   · status awaiting_text — гид нажал «Ответить», бот ждёт текст следующим
--     сообщением (new_value ещё нет); pending — показан предпросмотр, ждёт
--     кнопки; saved / cancelled / superseded — решено;
--   · live_value — что было, когда гид смотрел предпросмотр. Кнопка сверяет
--     его с тем, что в базе сейчас: поменяли на сайте — не пишет, показывает
--     новое «было». Пусто — JSON null, а не SQL NULL;
--   · один открытый черновик на чат (обеих таблиц: новый снимает и
--     pending правки тура 1357 — кодом, в той же транзакции);
--   · срок — expires_at (ожидание текста — 30 минут, предпросмотр — 2 часа).
-- Персональных данных нет: id отзыва, текст ответа гида, текст профиля.
--
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS guide_chat_drafts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  channel     TEXT        NOT NULL,
  chat_id     BIGINT      NOT NULL,
  kind        TEXT        NOT NULL,
  review_id   UUID        REFERENCES guide_reviews(id) ON DELETE CASCADE,
  field       TEXT,
  new_value   JSONB,
  live_value  JSONB,
  status      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  decided_at  TIMESTAMPTZ,
  CONSTRAINT guide_chat_drafts_channel_check CHECK (channel IN ('max', 'telegram')),
  CONSTRAINT guide_chat_drafts_kind_check CHECK (kind IN ('reply', 'reply_delete', 'profile')),
  CONSTRAINT guide_chat_drafts_status_check CHECK (status IN ('awaiting_text', 'pending', 'saved', 'cancelled', 'superseded')),
  CONSTRAINT guide_chat_drafts_target_check CHECK (
    (kind IN ('reply', 'reply_delete') AND review_id IS NOT NULL AND field IS NULL)
    OR (kind = 'profile' AND review_id IS NULL AND field IN ('description', 'experience_years', 'languages'))),
  -- Ждать текст умеет только ответ; предпросмотр без «станет» — только удаление.
  CONSTRAINT guide_chat_drafts_awaiting_check CHECK (status <> 'awaiting_text' OR kind = 'reply'),
  -- «Станет» есть у показанного и записанного (кроме удаления); снятое
  -- ожидание текста (cancelled, superseded) остаётся без него.
  CONSTRAINT guide_chat_drafts_value_check CHECK (
    status NOT IN ('pending', 'saved') OR kind = 'reply_delete' OR new_value IS NOT NULL),
  CONSTRAINT guide_chat_drafts_live_check CHECK (live_value IS NOT NULL),
  CONSTRAINT guide_chat_drafts_decided_check CHECK ((decided_at IS NULL) = (status IN ('awaiting_text', 'pending')))
);

CREATE UNIQUE INDEX IF NOT EXISTS guide_chat_drafts_one_open_per_chat
  ON guide_chat_drafts (channel, chat_id) WHERE status IN ('awaiting_text', 'pending');

CREATE INDEX IF NOT EXISTS guide_chat_drafts_partner_idx
  ON guide_chat_drafts (partner_id, created_at DESC);

COMMENT ON TABLE guide_chat_drafts IS
  'Ответ на отзыв и поле профиля гида из чата кабинета (1360): черновик до кнопки. Один открытый на чат; кнопка сверяет live_value с базой и пишет общей функцией сайта (lib/guides/review-reply, lib/guides/profile-write).';

COMMIT;
