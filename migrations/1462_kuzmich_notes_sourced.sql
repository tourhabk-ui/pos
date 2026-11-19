-- Migration 1462: заметки Кузьмича о местах — только с источником (#3514)
-- Created: 2026-11-19
--
-- Слово владельца 19.11 «1 поменять ответ из источников».
--
-- Записи agent_knowledge родов place/faq/transport (миграция 141) и
-- indigenous (669) Кузьмич отдавал людям без источника: промпт каждого чата,
-- get_place_info («Заметка Кузьмича …») и get_guardian_context. Среди них —
-- этимологии («Кухх — священный огонь»), цены такси и бассейнов, номера
-- автобусов, телефон санатория, «Камчатка не пограничная зона — пропуск не
-- нужен». У 669 «источник» — слово seed_indigenous, у 141 — никакого.
--
-- С этой правки читатель берёт запись, только если у неё в metadata.source_url
-- лежит адрес страницы (KUZMICH_KNOWLEDGE_SOURCED_SQL,
-- lib/kuzmich/knowledge-scope.ts). Записи без источника остаются в базе как
-- есть и наружу не идут.
--
-- Где источник есть, запись переписана фактами из него — и только ими. Это
-- две записи 141, расстояния в которых миграция 1377 сверила 03.11 (те же
-- числа и адреса — в lib/kuzmich/travel-facts.ts):
--   - paratunka-thermal — 60 км по автодороге, сайт курорта;
--   - malkinskie-springs — около 130 км по трассе, 4 км от трассы, по прямой
--     120 км; topkam.ru, kamchatskiytour.ru, nextroute.ru, Википедия.
-- Цены, номера автобусов, температура воды, «главный курортный район» в
-- источниках 1377 не сверялись — в новую запись не вошли. Прежний текст
-- сохранён в metadata.withdrawn_truth: вернуть можно по одной записи, с
-- источником.
--
-- Идемпотентно: запись переписывается, только пока у неё нет source_url.

UPDATE agent_knowledge
   SET metadata = metadata || jsonb_build_object(
         'withdrawn_truth', compiled_truth,
         'withdrawn_title', title,
         'withdrawn_at', '2026-11-19',
         'source_url', 'https://www.paratunka-sp.ru/poleznaya-informatsiya/kurort-paratunka/166-o-kurorte',
         'sources', jsonb_build_array(
           'https://www.paratunka-sp.ru/poleznaya-informatsiya/kurort-paratunka/166-o-kurorte'
         )
       ),
       title = 'Паратунка — сколько ехать от Петропавловска',
       compiled_truth = 'Курорт Паратунка — около 60 км к юго-западу от Петропавловска-Камчатского по автодороге (источник: сайт курорта, paratunka-sp.ru).',
       updated_at = NOW()
 WHERE slug = 'paratunka-thermal'
   AND agent_id = 'kuzmich'
   AND NOT (metadata ? 'source_url');

UPDATE agent_knowledge
   SET metadata = metadata || jsonb_build_object(
         'withdrawn_truth', compiled_truth,
         'withdrawn_title', title,
         'withdrawn_at', '2026-11-19',
         'source_url', 'https://www.topkam.ru/attractions/mineral_springs/mineralnye_istochniki_malkinskie.html',
         'sources', jsonb_build_array(
           'https://www.topkam.ru/attractions/mineral_springs/mineralnye_istochniki_malkinskie.html',
           'https://kamchatskiytour.ru/product/poseshhenie-malkinskih-gorjachih-istochnikov/',
           'https://nextroute.ru/experience/poezdka-k-malkinskim-termalynim-istochnikam-11264',
           'https://ru.wikipedia.org/wiki/Малки_(Камчатский_край)'
         )
       ),
       title = 'Малкинские источники — сколько ехать от Петропавловска',
       compiled_truth = 'Малкинские горячие источники — у посёлка Малки, около 130 км от Петропавловска-Камчатского по трассе на Мильково, источники в 4 км от трассы; по прямой — 120 км к северо-западу (источники: topkam.ru, kamchatskiytour.ru, nextroute.ru, Википедия «Малки (Камчатский край)»).',
       updated_at = NOW()
 WHERE slug = 'malkinskie-springs'
   AND agent_id = 'kuzmich'
   AND NOT (metadata ? 'source_url');

-- Rollback (по одной записи):
-- UPDATE agent_knowledge
--    SET title = metadata->>'withdrawn_title',
--        compiled_truth = metadata->>'withdrawn_truth',
--        metadata = metadata - 'withdrawn_truth' - 'withdrawn_title' - 'withdrawn_at' - 'source_url' - 'sources'
--  WHERE slug IN ('paratunka-thermal', 'malkinskie-springs') AND metadata ? 'withdrawn_truth';
