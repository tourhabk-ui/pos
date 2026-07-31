-- 792: чистка контент-дублей в external_alerts.
--
-- Дедуп при вставке шёл только по external_id (id поста). Суточная сводка
-- ГУ МЧС публикуется каждый день НОВЫМ постом с тем же текстом пункта
-- («Сохраняется риск схода оползней и обвалов с вулкана Мутновского…») —
-- каждый день появлялась новая строка при ещё активной старой. На /safety
-- одно предупреждение показывалось трижды, счётчик пилюли главной считал
-- дубли за отдельные угрозы.
--
-- Оставляем свежайшую строку каждой группы (alert_type, title, description),
-- срок действия группы отдаём выжившей строке (GREATEST по группе): повтор
-- того же текста — это подтверждение угрозы, а не новая угроза.
-- Код (saveEvent) с этой миграцией больше таких дублей не создаёт.
-- Идемпотентно: повторный прогон не находит ни дублей, ни устаревших сроков.

UPDATE external_alerts ea
SET expires_at = g.max_expires
FROM (
  SELECT alert_type, title, COALESCE(description, '') AS descr,
         MAX(expires_at) AS max_expires, MAX(created_at) AS max_created
  FROM external_alerts
  GROUP BY alert_type, title, COALESCE(description, '')
  HAVING COUNT(*) > 1
) g
WHERE ea.alert_type = g.alert_type
  AND ea.title = g.title
  AND COALESCE(ea.description, '') = g.descr
  AND ea.created_at = g.max_created
  AND ea.expires_at IS DISTINCT FROM g.max_expires;

DELETE FROM external_alerts ea
USING external_alerts newer
WHERE ea.alert_type = newer.alert_type
  AND ea.title = newer.title
  AND COALESCE(ea.description, '') = COALESCE(newer.description, '')
  AND newer.created_at > ea.created_at;
