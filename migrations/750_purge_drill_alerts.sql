-- 750_purge_drill_alerts.sql
--
-- «Пожарно-тактическое учение прошло в новом корпусе средней школы № 40»
-- висело алертом на каждой точке маршрутов (скрины владельца 2026-07-18).
-- Классификатор с 2026-07-17 отбрасывает учения/тренировки на входе
-- (lib/services/seismic-parser.ts), но СТАРЫЕ строки остались в
-- external_alerts и продолжали разлетаться по active_alerts при каждом
-- прогоне safety-ingest. Чистим и источник, и уже разложенные массивы.
--
-- Граница слова руками ((^|не-буква)): '\m' в PG зависит от locale ctype,
-- а «учени» без границы матчит «полУЧЕНИе пропусков» — реальный алерт.
-- Идемпотентна.

DELETE FROM external_alerts
 WHERE title ~* '(^|[^а-яё])(учени[еяй]|тренировк)'
    OR title ~* 'пожарно-тактическ'
    OR description ~* '(^|[^а-яё])(учени[еяй]|тренировк)'
    OR description ~* 'пожарно-тактическ';

UPDATE location_real_time_status
   SET active_alerts = (
     SELECT COALESCE(array_agg(a), ARRAY[]::TEXT[])
     FROM unnest(active_alerts) AS a
     WHERE NOT (a ~* '(^|[^а-яё])(учени[еяй]|тренировк)' OR a ~* 'пожарно-тактическ')
   )
 WHERE EXISTS (
   SELECT 1 FROM unnest(active_alerts) AS a
   WHERE a ~* '(^|[^а-яё])(учени[еяй]|тренировк)' OR a ~* 'пожарно-тактическ'
 );
