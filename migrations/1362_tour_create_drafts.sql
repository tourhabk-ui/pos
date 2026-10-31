-- Migration 1362: новый тур гида из чата кабинета — черновик до кнопки «Создать черновик»
-- Created: 2026-10-31
--
-- Слово владельца 31.10: гид сам создаёт свои туры («а должен») — до этого
-- ни в MAX/Telegram, ни в кабинете на сайте создания тура не было, раздел
-- «Свои туры» говорил «пришлите описание менеджеру». Решение по витрине —
-- прежнее («гид должен полностью управлять своей ролью из MAX»): тур
-- создаётся ЧЕРНОВИКОМ (is_published FALSE), на сайт его выводит сам гид
-- кнопкой «Опубликовать», если тур проходит витринный гейт
-- (lib/guides/own-tour-publish).
--
-- В чате тур заводится в два шага: фраза «новый тур: Горелый; цена 15000;
-- группа 4; описание: …» или документ Word (.docx, только MAX), тура из
-- которого нет среди своих, — предпросмотр полей; запись в operator_tours
-- — только кнопкой «Создать черновик», общей функцией сайта и чата
-- (lib/guides/own-tour-create, createOwnTourDraft). Между предпросмотром и
-- кнопкой поля живут здесь.
--
-- Соседняя таблица, а не строка 1357 или 1361: у правки — тур и «было», у
-- создания тура ещё нет, а набор полей другой (название и цена обязательны,
-- 1361 их запрещает). Смешать — значило бы снять проверки, которые держит
-- база.
--
-- Строка — одно создание:
--   · source: phrase — фраза, doc — документ;
--   · draft_values — поля нового тура, прошедшие проверку сайта (объект);
--     название, цена, размер группы и описание есть всегда;
--   · status: pending — показан предпросмотр; created — тур создан, tour_id
--     его номер (повтор кнопки второго тура не заводит); cancelled,
--     superseded — решено без записи;
--   · один pending на чат (новый черновик снимает и черновики 1357, 1360,
--     1361 этого чата — кодом, в той же транзакции); срок — expires_at.
-- Персональных данных нет: текст и цена тура гида.
--
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS tour_create_drafts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  channel        TEXT        NOT NULL,
  chat_id        BIGINT      NOT NULL,
  source         TEXT        NOT NULL,
  draft_values   JSONB       NOT NULL,
  tour_id        BIGINT      REFERENCES operator_tours(id) ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  decided_at     TIMESTAMPTZ,
  CONSTRAINT tour_create_drafts_channel_check CHECK (channel IN ('max', 'telegram')),
  CONSTRAINT tour_create_drafts_source_check CHECK (source IN ('phrase', 'doc')),
  CONSTRAINT tour_create_drafts_values_check CHECK (
    jsonb_typeof(draft_values) = 'object'
    AND draft_values ?& ARRAY['title', 'base_price', 'max_participants', 'description']),
  CONSTRAINT tour_create_drafts_status_check CHECK (status IN ('pending', 'created', 'cancelled', 'superseded')),
  CONSTRAINT tour_create_drafts_decided_check CHECK ((decided_at IS NULL) = (status = 'pending')),
  CONSTRAINT tour_create_drafts_created_check CHECK ((status = 'created') = (tour_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS tour_create_drafts_one_pending_per_chat
  ON tour_create_drafts (channel, chat_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS tour_create_drafts_partner_idx
  ON tour_create_drafts (partner_id, created_at DESC);

COMMENT ON TABLE tour_create_drafts IS
  'Новый тур гида из чата кабинета (1362): поля до кнопки «Создать черновик». Тур создаётся черновиком общей функцией lib/guides/own-tour-create; на сайт его выводит гид кнопкой «Опубликовать» (lib/guides/own-tour-publish).';

COMMIT;
