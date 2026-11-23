-- Migration 1505: три служебные карточки — с витрины.
-- Created: 2026-11-23
--
-- Слово владельца 23.11: «Скрыть тестовые карточки и карточку Admin в
-- "/api/partners" и на "/guides"».
--
-- Замер 23.11 (GET /api/partners на проде): на витрине 12 карточек, из них
-- три служебные — «Admin» (оператор), «Тестовый оператор Ведар» (оператор,
-- стенд запросов мест lib/seat-requests/test-stand.ts) и «Тестовый гид Ведар»
-- (гид; он же стоял на странице /guides рядом с настоящим гидом).
--
-- Почему они остались: 1495 ставила отметку тестового профиля карточке с
-- почтой flo@vedarai.ru, а у стенда почта другая — строка не совпала. Список
-- компаний и sitemap обходили стенд по id из кода; /api/partners и /guides —
-- нет.
--
-- Что делается:
--  - два тестовых профиля получают отметку is_test и уходят с витрины. CHECK
--    partners_test_not_public (1495) после этого не даст вернуть их на
--    витрину, пока отметка стоит. Стенд запросов мест от витрины не зависит:
--    он открывает свой неопубликованный тур по id партнёра;
--  - «Admin» — карточка владельца, не тестовый профиль: только снимается с
--    витрины (is_public). Кабинет и доступы не меняются.
--
-- Строка берётся по id И имени: на базе, где под этим id другая карточка
-- (или карточки нет), миграция ничего не трогает и ничего не выдумывает.
-- Повтор ничего не меняет — в том числе время правки.

BEGIN;

UPDATE partners
   SET is_test = TRUE,
       is_public = FALSE,
       updated_at = NOW()
 WHERE (id::text, name) IN (
         ('0c595568-163b-4870-ab03-edf60d1d939e', 'Тестовый оператор Ведар'),
         ('11a01651-3840-4669-a6ee-0f66f3fd4256', 'Тестовый гид Ведар')
       )
   AND (is_test IS DISTINCT FROM TRUE OR is_public IS DISTINCT FROM FALSE);

UPDATE partners
   SET is_public = FALSE,
       updated_at = NOW()
 WHERE id::text = '1b071e25-c0da-4e3c-965a-74fd1eec6f36'
   AND name = 'Admin'
   AND is_public IS DISTINCT FROM FALSE;

COMMIT;

-- Rollback (вернуть на витрину — решение администратора, по одной карточке):
-- BEGIN;
-- UPDATE partners SET is_test = FALSE
--  WHERE id::text IN ('0c595568-163b-4870-ab03-edf60d1d939e', '11a01651-3840-4669-a6ee-0f66f3fd4256');
-- UPDATE partners SET is_public = TRUE
--  WHERE id::text IN ('0c595568-163b-4870-ab03-edf60d1d939e', '11a01651-3840-4669-a6ee-0f66f3fd4256',
--                     '1b071e25-c0da-4e3c-965a-74fd1eec6f36');
-- COMMIT;
