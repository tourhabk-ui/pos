-- Migration 1189: ролик перевозчика «Шатун» — медведи вместо повтора переправы
-- Created: 2026-10-09
--
-- Владелец 09.10: «видео дублируются, добавь нижним видео медведей». Нижний
-- ролик карточки (1185) — та же переправа, из которой нарезаны клипы ленты
-- над ним (1186): человек смотрел одни и те же кадры дважды. Внизу теперь
-- медведи на реке — файл прислал владелец; звук и метаданные съёмки вырезаны,
-- как у прежнего ролика (решение владельца 09.10 «без звука»), без подписи о
-- том, ГДЕ снято: в присланном этого нет.
--
-- UPDATE только там, где всё ещё переправа: ролик, поставленный руками после
-- 1185, не перезаписывается. Файл переправы остаётся в public/ — на него
-- ссылается 1185 для свежей базы, из него же нарезаны клипы.
--
-- Форма значений — под CHECK partners_video_shape (1185): ролик и обложка
-- из /video/, обложка обязательна.

BEGIN;

UPDATE partners
   SET video_url        = '/video/shatun/shatun-bears.mp4',
       video_poster_url = '/video/shatun/shatun-bears.poster.jpg'
 WHERE slug = 'shatun'
   AND video_url = '/video/shatun/shatun-river-crossing.mp4';

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE partners
--    SET video_url        = '/video/shatun/shatun-river-crossing.mp4',
--        video_poster_url = '/video/shatun/shatun-river-crossing.poster.jpg'
--  WHERE slug = 'shatun' AND video_url = '/video/shatun/shatun-bears.mp4';
-- COMMIT;
