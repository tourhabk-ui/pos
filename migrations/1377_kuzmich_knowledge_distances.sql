-- Migration 1377: расстояния в agent_knowledge сверены с источниками (03.11.2026).
-- Малки: «200 км» из 141 неверно — по трассе около 130 км (topkam.ru, kamchatskiytour.ru,
--   nextroute.ru), по прямой 120 км к СЗ (Википедия, places 1040).
-- Паратунка: «30 км» расходится с официальным сайтом курорта — 60 км по автодороге
--   (https://www.paratunka-sp.ru/poleznaya-informatsiya/kurort-paratunka/166-o-kurorte).
-- Идемпотентно: replace по точной старой фразе.

UPDATE agent_knowledge
SET compiled_truth = replace(compiled_truth, 'Расположены в 200 км от Петропавловска',
      'Расположены примерно в 130 км от Петропавловска по трассе на Мильково (по прямой 120 км; источники topkam.ru, kamchatskiytour.ru)'),
    updated_at = NOW()
WHERE slug = 'malkinskie-springs' AND compiled_truth LIKE '%в 200 км от Петропавловска%';

UPDATE agent_knowledge
SET compiled_truth = replace(compiled_truth, '30 км от Петропавловска-Камчатского',
      'около 60 км от Петропавловска-Камчатского по автодороге (сайт курорта paratunka-sp.ru)'),
    updated_at = NOW()
WHERE slug IN ('paratunka-thermal', 'svetlyachok-sanatorium') AND compiled_truth LIKE '%30 км от Петропавловска-Камчатского%';
