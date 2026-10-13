-- Migration 1236: ловушка ошибок браузера (решение владельца 13.10: «ловушку»)
-- Created: 2026-10-13
--
-- Владелец 13.10: «у нас много багов ещё попадается». В issues при этом
-- открыто два бага, и оба ждут решения владельца, а не кода: баги, на которые
-- натыкаются на сайте, нигде не записываются. О падении страницы знает
-- только тот, у кого она упала, — сбора ошибок браузера на платформе не было.
--
-- Строка — одна ошибка в браузере (window error, unhandledrejection, граница
-- React), как её прислал клиент через POST /api/client-errors. Без ПД:
-- сообщение и стек чистятся (redactPII, ключи, query-строки адресов), путь —
-- без query и фрагмента (в них бывают ключи: /request-status#<ключ>), вместо
-- IP и User-Agent — суточный visitor_hash как у page_views (по нему ошибку
-- можно сопоставить с просмотрами того же дня) и род устройства и браузера
-- одним словом.
--
-- fingerprint — отпечаток группы: одна и та же ошибка у разных людей
-- склеивается в переписи по нему, а не по тексту с номерами строк.
-- is_self — заход владельца (cookie vedar_self), is_bot — заголовок бота:
-- оба не выбрасываются, а помечаются, как в page_views.
--
-- occurred_at — когда случилось у клиента: офлайн-очередь досылает ошибку
-- позже, и created_at тогда врёт о времени. NULL — клиент времени не прислал.
--
-- Хранение 30 дней: перепись client-errors-census с ?prune=1 удаляет старше.

BEGIN;

CREATE TABLE IF NOT EXISTS client_errors (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurred_at   TIMESTAMPTZ,
  -- error | unhandledrejection | boundary
  kind          VARCHAR(24)   NOT NULL,
  message       VARCHAR(1000) NOT NULL,
  stack         VARCHAR(4000),
  fingerprint   VARCHAR(16)   NOT NULL,
  path          VARCHAR(500)  NOT NULL,
  -- phone | tablet | desktop | unknown
  device        VARCHAR(16)   NOT NULL,
  -- chrome | safari | firefox | yandex | edge | samsung | opera | other
  browser       VARCHAR(16)   NOT NULL,
  -- navigator.onLine в момент ошибки; NULL — не прислано
  online        BOOLEAN,
  -- коммит сборки прода, принявшей ошибку (public/version.json); NULL — маркера нет
  build         VARCHAR(40),
  visitor_hash  VARCHAR(64),
  is_bot        BOOLEAN NOT NULL DEFAULT FALSE,
  is_self       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_client_errors_created
  ON client_errors (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_errors_fingerprint
  ON client_errors (fingerprint, created_at DESC);

COMMIT;
