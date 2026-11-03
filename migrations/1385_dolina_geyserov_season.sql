-- Migration 1385: сезон Долины гейзеров сверен с Кроноцким заповедником (03.11.2026).
-- Эвал season-2/route-2: у маршрута стоял сезон 'all' (импорт паспортов, не
-- проверено), промпт говорил «июнь–сентябрь», описания из миграции 153 —
-- «с июля по сентябрь». Официально (kronoki.ru):
--   https://kronoki.ru/ru/news/newswire/2840.html — сезон «конец мая – конец сентября»;
--   https://kronoki.ru/ru/visit/information-for-all/excursions/147.html — в мае и июне
--   ограничения («месячник тишины»).
-- Номер 1385: 1378–1379 заняты открытыми PR. Идемпотентно.

UPDATE kamchatka_routes
SET season = 'конец мая – конец сентября (в мае–июне ограничения, kronoki.ru)',
    updated_at = NOW()
WHERE title IN ('Долина гейзеров', 'Долина гейзеров и кальдера Узон', 'Кальдера Узон — Долина гейзеров')
  AND (season IS NULL OR season IN ('all', 'summer', 'Летний сезон'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kamchatka_routes', '_agent_route_knowledge_legacy'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format($q$
        UPDATE %I SET description = replace(replace(description,
          'Туристический сезон длится с июля по сентябрь, когда погода наиболее благоприятна.',
          'Туристический сезон — конец мая – конец сентября; в мае и июне на маршруте ограничения из-за брачного периода медведей (по данным Кроноцкого заповедника, kronoki.ru).'),
          'Туристический сезон длится с июля по сентябрь, когда погода наиболее стабильна.',
          'Туристический сезон — конец мая – конец сентября; в мае и июне на части маршрутов ограничения (по данным Кроноцкого заповедника, kronoki.ru).')
        WHERE id IN ('796c18b3-e199-4ac6-bbd6-de50d560ff40', '7467ef9e-2735-4eec-b0f8-7491eabea3f1')
          AND description LIKE '%%Туристический сезон длится с июля по сентябрь%%'$q$, t);
    END IF;
  END LOOP;
END $$;
