-- 1207: ещё один снимок «Кутхи» — автор владелец платформы (10.10: «это тоже
-- фото, но автор я», подпись «Фото: Андрей»).
--
-- Из пяти присланных взят один — стена прихожей с резными фигурками. Три
-- других показывают старую доску с ценами («Сутки 6-8 человек — 20 000 р.»),
-- которая спорит с нынешними 24 000 / 28 000 (1205): гость увидел бы на одной
-- карточке две разные цены. Ещё один — дом в прежнем виде и не в фокусе.
--
-- Подпись автора — в alt: просмотрщик карточки показывает его под снимком.
-- Снимок встаёт последним (привязан позже двадцати из 1204). Пишется только
-- объекту, у которого фото уже есть (1204), и только если этот снимок ещё не
-- привязан. Идемпотентна.

WITH k AS (
  SELECT a.id
    FROM accommodations a
   WHERE LOWER(a.name) = 'кутха'
     AND EXISTS (SELECT 1 FROM accommodation_assets aa WHERE aa.accommodation_id::text = a.id::text)
),
ins AS (
  INSERT INTO assets (url, mime_type, sha256, size, width, height, alt)
  SELECT '/images/kutha/kutha-21.jpg', 'image/jpeg',
         'b1c07dac9bbff10fa3d5a90a5b1c701a40f8d488a68dbec205cd706934bc94be', 169260, 960, 1707,
         'Прихожая: резные фигурки и вешалка с горами. Фото: Андрей'
   WHERE EXISTS (SELECT 1 FROM k)
     AND NOT EXISTS (SELECT 1 FROM assets s WHERE s.url = '/images/kutha/kutha-21.jpg')
  RETURNING id
)
INSERT INTO accommodation_assets (accommodation_id, asset_id)
SELECT k.id, ins.id FROM k CROSS JOIN ins;
