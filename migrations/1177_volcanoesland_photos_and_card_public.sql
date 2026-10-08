-- 1177: фото туров «Края Вулканов» и публикация карточки компании (#2245).
--
-- Владелец 08.10: «публикуй фото и туры». Туры опубликованы в 1176; здесь —
-- фото и карточка партнёра.
--
-- Фото: по 5 первых снимков галереи с каждой карточки тура volcanoesland.ru
-- (адреса — проба 713, оригиналы — workflow operator-photos, ветка
-- photos/volcanoesland-20261008-0604). Сжаты sharp до 1600px/q80 в
-- public/images/volcanoesland/, варианты 320/640/1280 webp — npm run images
-- (манифест lib/images/photo-variants.json). Права на снимки — у оператора,
-- перенос по слову владельца. Hero — первый снимок (tour_image = photos[1]).
-- Пишутся только туда, где фото ещё нет: загруженное оператором в кабинете
-- не затирается.
--
-- Карточка партнёра: is_public = TRUE — по тому же слову «публикуй».
-- is_verified и registry_status не трогаются: платформа компанию не
-- проверяла, отметку «проверено» даёт только администратор.

UPDATE operator_tours t
   SET photos = v.photos,
       tour_image = v.photos[1],
       updated_at = NOW()
  FROM (VALUES
  ('volcanoesland-kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha', ARRAY['/images/volcanoesland/kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha-01.jpg', '/images/volcanoesland/kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha-02.jpg', '/images/volcanoesland/kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha-03.jpg', '/images/volcanoesland/kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha-04.jpg', '/images/volcanoesland/kurilskoe-ozero-dolina-geyzerov-gorelyy-avacha-05.jpg']::text[]),
  ('volcanoesland-ploskiy-tolbachik', ARRAY['/images/volcanoesland/ploskiy-tolbachik-01.jpg', '/images/volcanoesland/ploskiy-tolbachik-02.jpg', '/images/volcanoesland/ploskiy-tolbachik-03.jpg', '/images/volcanoesland/ploskiy-tolbachik-04.jpg', '/images/volcanoesland/ploskiy-tolbachik-05.jpg']::text[]),
  ('volcanoesland-oblet-klyuchevskoy-gruppy-dolina-geyzerov', ARRAY['/images/volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-01.jpg', '/images/volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-02.jpg', '/images/volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-03.jpg', '/images/volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-04.jpg', '/images/volcanoesland/oblet-klyuchevskoy-gruppy-dolina-geyzerov-05.jpg']::text[]),
  ('volcanoesland-splav-bystraya-gorelyy-avachinskiy', ARRAY['/images/volcanoesland/splav-bystraya-gorelyy-avachinskiy-01.jpg', '/images/volcanoesland/splav-bystraya-gorelyy-avachinskiy-02.jpg', '/images/volcanoesland/splav-bystraya-gorelyy-avachinskiy-03.jpg', '/images/volcanoesland/splav-bystraya-gorelyy-avachinskiy-04.jpg', '/images/volcanoesland/splav-bystraya-gorelyy-avachinskiy-05.jpg']::text[]),
  ('volcanoesland-treking-karymskiy-malyy-semyachik-nalychevo', ARRAY['/images/volcanoesland/treking-karymskiy-malyy-semyachik-nalychevo-01.jpg', '/images/volcanoesland/treking-karymskiy-malyy-semyachik-nalychevo-02.jpg', '/images/volcanoesland/treking-karymskiy-malyy-semyachik-nalychevo-03.jpg', '/images/volcanoesland/treking-karymskiy-malyy-semyachik-nalychevo-04.jpg', '/images/volcanoesland/treking-karymskiy-malyy-semyachik-nalychevo-05.jpg']::text[]),
  ('volcanoesland-treking-podnozhie-klyuchevskoy', ARRAY['/images/volcanoesland/treking-podnozhie-klyuchevskoy-01.jpg', '/images/volcanoesland/treking-podnozhie-klyuchevskoy-02.jpg', '/images/volcanoesland/treking-podnozhie-klyuchevskoy-03.jpg', '/images/volcanoesland/treking-podnozhie-klyuchevskoy-04.jpg', '/images/volcanoesland/treking-podnozhie-klyuchevskoy-05.jpg']::text[]),
  ('volcanoesland-treking-vokrug-ploskogo-tolbachika', ARRAY['/images/volcanoesland/treking-vokrug-ploskogo-tolbachika-01.jpg', '/images/volcanoesland/treking-vokrug-ploskogo-tolbachika-02.jpg', '/images/volcanoesland/treking-vokrug-ploskogo-tolbachika-03.jpg', '/images/volcanoesland/treking-vokrug-ploskogo-tolbachika-04.jpg', '/images/volcanoesland/treking-vokrug-ploskogo-tolbachika-05.jpg']::text[]),
  ('volcanoesland-voskhozhdenie-klyuchevskaya-sopka', ARRAY['/images/volcanoesland/voskhozhdenie-klyuchevskaya-sopka-01.jpg', '/images/volcanoesland/voskhozhdenie-klyuchevskaya-sopka-02.jpg', '/images/volcanoesland/voskhozhdenie-klyuchevskaya-sopka-03.jpg', '/images/volcanoesland/voskhozhdenie-klyuchevskaya-sopka-04.jpg', '/images/volcanoesland/voskhozhdenie-klyuchevskaya-sopka-05.jpg']::text[]),
  ('volcanoesland-kruiz-komandorskie-ostrova', ARRAY['/images/volcanoesland/kruiz-komandorskie-ostrova-01.jpg', '/images/volcanoesland/kruiz-komandorskie-ostrova-02.jpg', '/images/volcanoesland/kruiz-komandorskie-ostrova-03.jpg', '/images/volcanoesland/kruiz-komandorskie-ostrova-04.jpg', '/images/volcanoesland/kruiz-komandorskie-ostrova-05.jpg']::text[]),
  ('volcanoesland-dolina-geyzerov-kaldera-uzon', ARRAY['/images/volcanoesland/dolina-geyzerov-kaldera-uzon-01.jpg', '/images/volcanoesland/dolina-geyzerov-kaldera-uzon-02.jpg', '/images/volcanoesland/dolina-geyzerov-kaldera-uzon-03.jpg', '/images/volcanoesland/dolina-geyzerov-kaldera-uzon-04.jpg', '/images/volcanoesland/dolina-geyzerov-kaldera-uzon-05.jpg']::text[]),
  ('volcanoesland-avtotur-kurilskoe-ozero', ARRAY['/images/volcanoesland/avtotur-kurilskoe-ozero-01.jpg', '/images/volcanoesland/avtotur-kurilskoe-ozero-02.jpg', '/images/volcanoesland/avtotur-kurilskoe-ozero-03.jpg', '/images/volcanoesland/avtotur-kurilskoe-ozero-04.jpg', '/images/volcanoesland/avtotur-kurilskoe-ozero-05.jpg']::text[])
  ) AS v(slug, photos)
  JOIN partners p ON p.slug = 'volcanoesland'
 WHERE t.operator_id::text = p.id::text
   AND t.slug = v.slug
   AND COALESCE(array_length(t.photos, 1), 0) = 0;

UPDATE partners
   SET is_public = TRUE, updated_at = NOW()
 WHERE slug = 'volcanoesland' AND is_public IS DISTINCT FROM TRUE;

DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM operator_tours t
   JOIN partners p ON p.id::text = t.operator_id::text
  WHERE p.slug = 'volcanoesland' AND t.deleted_at IS NULL
    AND COALESCE(array_length(t.photos, 1), 0) = 0;
  IF n <> 0 THEN
    RAISE WARNING '1177: у % туров volcanoesland по-прежнему нет фото', n;
  END IF;
END $$;
