-- 1321: согласие партнёра на использование материалов его сайта на Ведаре
-- (решение владельца 23.10: «нужна форма согласия об использовании
-- матерьялов сайтов партнеров на нашем сайте»).
--
-- До этой миграции согласие партнёра на снимки, логотип и тексты жило только
-- словами в шапках миграций: «ДА» «Местечка» в WhatsApp (1216), «согласия на
-- снимки не было» у «Лагуны» (1318), затем её фото и логотип по слову
-- владельца (1319, 1320). Ни версии текста, ни объёма, ни подписанта, ни
-- отзыва записать было некуда. Две прежние попытки (content_consents,
-- /api/operator-agreements/content-consent) удалены 15.10: таблиц не было на
-- проде.
--
-- Здесь — запись с производителем и потребителем в одном PR (§10.09):
--   · производитель — страница /partner-consent по одноразовой ссылке, которую
--     администратор выпускает в карточке партнёра и пересылает в MAX/Telegram
--     (партнёр без аккаунта, как отзыв о перевозчике 1235);
--   · потребители — статус в админке партнёра и строка «с согласия партнёра от
--     ДД.ММ» на его собственной странице перевозчика и прокатчика.
--
-- Объём — не «вообще да»: виды материалов × где их показывать. 1263 и 1265
-- уже показали, что «ДА» на туры не покрывает карточки мест. Своя страница
-- партнёра входит всегда — без неё согласие ни о чём; общие витрины, ответы
-- помощников и каналы — по выбору партнёра.
--
-- Текст согласия и его версия — lib/legal/partner-materials-consent.ts;
-- согласие подписанта на обработку его имени и должности — отдельная
-- галочка (purpose 'partner-signer', lib/legal/pd-consent.ts), набор колонок
-- как у 911.
--
-- Отзыв — revoked_at с причиной (CHECK: оба поля вместе), строка не
-- удаляется: «отозвали» и «не было» — разные состояния.
--
-- Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS partner_material_consents (
  id                   BIGSERIAL PRIMARY KEY,
  partner_id           UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- Версия текста, под которым подписались (никогда задним числом).
  text_version         VARCHAR(32) NOT NULL,
  materials            TEXT[] NOT NULL
                         CHECK (cardinality(materials) > 0
                                AND materials <@ ARRAY['photos','video','logo','texts','prices']::TEXT[]),
  surfaces             TEXT[] NOT NULL
                         CHECK ('own_page' = ANY (surfaces)
                                AND surfaces <@ ARRAY['own_page','showcases','assistants','channel']::TEXT[]),
  -- Снимок адресов сайтов на момент подписи: сайт у партнёра меняется (879).
  sites                TEXT[] NOT NULL DEFAULT '{}',
  signer_name          VARCHAR(120) NOT NULL CHECK (length(btrim(signer_name)) >= 2),
  signer_role          VARCHAR(120) NOT NULL CHECK (length(btrim(signer_role)) >= 2),
  -- Откуда пришло: пока только одноразовая ссылка. Новый путь — вместе с его производителем.
  source               VARCHAR(16) NOT NULL CHECK (source IN ('link')),
  granted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pd_consent_at        TIMESTAMPTZ NOT NULL,
  pd_consent_ip        VARCHAR(64) NOT NULL,
  pd_consent_source    VARCHAR(64) NOT NULL,
  pd_consent_version   VARCHAR(32) NOT NULL,
  revoked_at           TIMESTAMPTZ,
  revoke_reason        TEXT,
  -- revoke_reason IS NOT NULL — явно: length(btrim(NULL)) даёт NULL, а CHECK
  -- с исходом NULL проходит, и отзыв без причины лёг бы молча (поймано
  -- интеграционным тестом на настоящем PostgreSQL).
  CONSTRAINT partner_material_consents_revoke_pair
    CHECK ((revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) >= 8))
);

CREATE INDEX IF NOT EXISTS partner_material_consents_partner_idx
  ON partner_material_consents (partner_id, granted_at DESC);

-- Одноразовая ссылка: одна на партнёра, новая заменяет хэш — прежняя гаснет.
-- В базе только sha256 ключа; ключ живёт во фрагменте адреса (как 1235).
CREATE TABLE IF NOT EXISTS partner_consent_invites (
  partner_id   UUID PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

COMMIT;
