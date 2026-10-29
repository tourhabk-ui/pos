-- 1347: обложка компании «Лагуна Экспедиция» — её собственный кадр.
--
-- Основание. Владелец 29.10, после выката 1343: «нет фото Лагуны экспедиции».
-- 1343 положила снимки в 34 тура и логотип партнёру, а обложку компании
-- (partners.hero_image) не трогала. Список компаний /operators рисует карточку
-- по hero_image, страница компании — hero_image, затем gallery[0]; у «Лагуны
-- Экспедиции» нет ни того ни другого, и обе показывали пустую заглушку, хотя
-- снимков у компании полторы сотни. Согласие на снимки — то же, что у 1343:
-- «они дали добро на использоваеие» (29.10); записанное согласие партнёр
-- подписывает сам на /partner-consent (1321).
--
-- Кадр. Выбран глазами из обложек её туров (29.10):
--   k-gamulam-na-vilyuchinskij-pereval-cover — её вездеход на снегу под
--     Вилючинским, ясное небо, людей нет, 1600×1067. На двери — эмблема,
--     адреса сайта нет — ВЫБРАН;
--   k-domashnim-vulkanam-…-cover — три машины и группа людей у Корякского:
--     люди в кадре, лицом компании чужих людей не ставим (как 1270, 1343);
--   obljot-avachinskoj-bukhty-…-cover — бухта с воздуха, 1206 px — мельче;
--   obljot-vulkanov-…-cover — портрет, вулкан в окне вертолёта: в карточке
--     176 px высотой обрезается до рамы окна.
-- Файл уже в хранилище (media-to-s3, прогон 17) и подписан «Лагуна Экспедиция»
-- в gallery_credits той же 1343 — новый файл не нужен.
--
-- Гейт. Ставится только в пустую обложку: выбор оператора в кабинете или
-- администратора миграция не перетирает. Повтор ничего не меняет. Карточки нет
-- — WARNING и ничего.
--
-- Вернуть (если понадобится):
-- UPDATE partners SET hero_image = NULL, updated_at = NOW() WHERE slug = 'laguna-expedition' AND hero_image = '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-cover.jpg';

UPDATE partners
   SET hero_image = '/api/images/s3/photos/laguna-expedition/k-gamulam-na-vilyuchinskij-pereval-cover.jpg',
       updated_at = NOW()
 WHERE slug = 'laguna-expedition'
   AND NULLIF(btrim(hero_image), '') IS NULL;

DO $$
DECLARE
  v_p integer;
BEGIN
  SELECT count(*) INTO v_p FROM partners WHERE slug = 'laguna-expedition';
  IF v_p = 0 THEN
    RAISE WARNING '[1347] карточек laguna-expedition: 0 — обложка не поставлена';
  END IF;
END $$;
