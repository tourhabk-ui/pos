-- 1320: логотип «Лагуны Прокат» (решение владельца 23.10: «и логотип лагуны /
-- если есть видео / го»).
--
-- Источник: логотип с сайта прокатчика лагунапрокат.рф (шапка сайта, файл
-- tild3831-3234-4732-b635-656161326661/_.png на static.tildacdn.com), снят
-- 23.10, уменьшен до 512×512 с прозрачным фоном и положен в
-- public/images/laguna-prokat/laguna-logo.png. Права — у партнёра, который
-- сам попросился на платформу (1318); подпись автора у логотипа не нужна.
--
-- Видео у партнёра НЕ появляется: на сайте его нет ни на одной из шести
-- страниц (главная, /rent/tank300, /rent/suzuki, /rent/sever, /rent/ford,
-- /rent/ural) — сверено по разметке 23.10; выдумывать ролик нельзя (§4.0).
--
-- Логотип ставится только туда, где его нет: партнёр мог загрузить свой из
-- админки, и чужой выбор не перетирается (как 1174, 1216, 1234). Показывают
-- его герой и блок «Прокатчик»/«Перевозчик» на /car-rental/laguna-prokat и
-- /transfers/laguna-prokat, карточки в списках /car-rental и /transfers и
-- разметка AutoRental/Organization полем logo.
--
-- Идемпотентно: повторный прогон ничего не меняет.
BEGIN;

UPDATE partners
   SET logo_image = '/images/laguna-prokat/laguna-logo.png',
       updated_at = NOW()
 WHERE slug = 'laguna-prokat'
   AND (logo_image IS NULL OR logo_image = '');

-- Исход называется вслух: партнёра нет или логотипов два — предупреждение,
-- а не тихий ноль (партнёра сеет 1318).
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM partners
   WHERE slug = 'laguna-prokat' AND logo_image IS NOT NULL AND logo_image <> '';
  IF v_n <> 1 THEN
    RAISE WARNING '[1320] «Лагуна Прокат» с логотипом: найдено % записей (нужна ровно одна)', v_n;
  END IF;
END $$;

COMMIT;
