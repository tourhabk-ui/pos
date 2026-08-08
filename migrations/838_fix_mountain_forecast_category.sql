-- 838: чинит категорию Mountain-Forecast в каталоге AI-инструментов.
--
-- В сиде (666_external_tools.sql) записи вместо категории прописали её
-- собственный slug: ('mountain-forecast', ..., 'mountain-forecast', ...).
-- На витрине /ai-tools из-за этого висел чип-призрак «mountain-forecast (1)»,
-- а сам инструмент выпал из «Туризма» (его соседи по сиду — AllTrails,
-- Peakbagger, Gaia GPS — все 'travel'). Допустимые категории — см. DDL 666:
-- safety|geo|image|text|audio|data|travel|other.
--
-- Идемпотентно: после первого применения WHERE не находит строк.

UPDATE external_tools
   SET category = 'travel'
 WHERE slug = 'mountain-forecast'
   AND category = 'mountain-forecast';
