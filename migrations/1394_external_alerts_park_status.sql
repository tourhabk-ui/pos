-- Migration 1394: дата последней сводки и кто погасил тревогу (решение
-- владельца 06.11, «1 да»: закрытие парка на межсезонье держится до сводки
-- об открытии, после предела — «не знаю», ответ называет дату последней
-- сводки).
--
-- 1. external_alerts.last_published_at — дата последней публикации, которая
--    эту строку подтвердила. created_at — дата ПЕРВОГО поста: повтор сводки
--    продлевал срок (saveEvent, GREATEST), но «сообщение от» в ленте и MCP
--    называло первый пост, и сводка, повторённая вчера, читалась
--    трёхнедельной. Тип — timestamp без пояса, стенное UTC, как created_at
--    (#2495, миграция 1269): с timestamptz GREATEST по поясу сессии
--    сдвинул бы время на три часа. Уже лежащим строкам — created_at: точнее
--    восстановить нечем (журнал дедупа даты повтора не хранил).
--
-- 2. external_alerts.ended_by — кто погасил строку раньше её срока:
--    admin       — администратор (DELETE /api/admin/external-alerts/[id])
--    reopening   — сводка об открытии сняла все парки закрытия
--                  (lib/services/safety/park-reopening.ts)
--    legacy      — погашено до этой миграции, кем — не записано.
--    NULL        — срок истёк сам либо строка жива.
--    Без метки «не знаю» после истёкшего закрытия воскресило бы снятое
--    человеком: до этой правки DELETE ставил только expires_at = now, и
--    отличить снятое от истёкшего было нечем (park-closure-hold.ts, ревью
--    06.11). Поэтому уже истёкшие закрытия парков помечены legacy — их
--    «истёк сам» или «снял человек» не различить, и выводить из них «не
--    знаю» нельзя.
--
-- Граница пометки legacy — момент прогона, но не позже 16.11 (срок правки).
-- Повторный прогон не пометит закрытие, истёкшее уже при новом коде, — его
-- истечение записано честно (ended_by IS NULL), и «не знаю» из него законно.
-- Ошибка границы в сторону «не пометили» даёт жёлтое «не знаю», а не
-- зелёное.
--
-- Идемпотентна. Колонки IF NOT EXISTS (CHECK вместе с колонкой), заполнение
-- только пустого.

ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS last_published_at TIMESTAMP;

ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS ended_by VARCHAR(16)
  CONSTRAINT external_alerts_ended_by_check CHECK (ended_by IN ('admin', 'reopening', 'legacy'));

UPDATE external_alerts
   SET last_published_at = created_at
 WHERE last_published_at IS NULL;

-- Время тревог — стенное UTC (#2495).
UPDATE external_alerts
   SET ended_by = 'legacy'
 WHERE alert_type = 'park_closure'
   AND ended_by IS NULL
   AND expires_at <= LEAST((NOW() AT TIME ZONE 'UTC'), TIMESTAMP '2026-11-16 00:00:00');

-- Rollback:
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS ended_by;
-- ALTER TABLE external_alerts DROP COLUMN IF EXISTS last_published_at;
