-- 1292: перевозчик «ИП Желтухин» — микроавтобусы под заказ, цена за час и за полный день.
--
-- Владелец 15.10 переслал слова перевозчика: «Час 4.500 рублей, полный день
-- 45.000 рублей. Направлений нет, отдельно оговариваются дальние поездки. ИП
-- Желтухин Михаил Анатольевич, лицензия … есть конечно же, страховка пассажиров
-- тоже», телефон, ИНН, снимки машин и выписку из реестра лицензий. Ответы
-- владельца на вопросы: вывеска — «ИП Желтухин»; отметки «Проверенный
-- перевозчик» нет — «только факты»; снимки — «только живые»; «вахтовок нет».
--
-- ── Почему два новых рода строк прайса ────────────────────────────────────
--
-- Прайс 1185 знал два рода: цена за машину на направление и доплата за день
-- работы на месте. У Желтухина направлений нет: цена — за время работы машины,
-- а куда ехать, задаёт заказчик. Записать «час» направлением значило бы
-- выдумать направление; доплатой за день — назвать полную цену дня доплатой.
-- Поэтому два новых рода: `per_hour` (цена за машину за час работы) и
-- `per_day` (за полный день). У них, как у доплаты, нет ни «откуда», ни «куда».
-- Один тариф каждого рода на тип машины — как одна доплата у 1185.
--
-- ── Что записано дословно, чего НЕТ ────────────────────────────────────────
--
--   • 4 500 ₽ за час и 45 000 ₽ за полный день — за МАШИНУ, не за место.
--   • «Дальние поездки оговариваются отдельно» — условие (conditions) у обеих
--     строк: цену дальней поездки называет перевозчик.
--   • Сколько часов в «полном дне», есть ли минимальный заказ, входят ли
--     топливо и подача — не сказано. Колонок под это нет, страница говорит
--     «уточняется у перевозчика» (§4.0).
--   • Год прайса не назван — valid_year NULL («не записан»).
--   • Парк — три машины со снимков перевозчика: два Mercedes-Benz Sprinter и
--     Ford Transit (вахтовок нет, слово владельца). Число мест не названо, и
--     `transfer_fleet_vehicles.seats` перестаёт быть обязательным: NULL —
--     «не записано», экраны так и говорят, вместо придуманной цифры. Проверка
--     `seats > 0` остаётся для записанного числа.
--
-- ── Исполнитель и лицензия ────────────────────────────────────────────────
--
--   • legal_info.companyName — «ИП Желтухин Михаил Анатольевич», ИНН
--     410209072036 — со слов перевозчика, и то же в выписке; ОГРН (у ИП это
--     ОГРНИП) 313417727300072 — из выписки.
--   • Лицензия — из выписки из реестра лицензий, присланной владельцем:
--     номер, дата предоставления, лицензирующий орган и статус «действует» по
--     состоянию на 04.05.2026. Это статус на дату выписки, а не на сегодня, и
--     страница называет дату. Вид лицензируемой деятельности на присланном
--     листе не виден — и не пишется.
--   • В выписке есть паспортные данные и адрес предпринимателя. Они в базу НЕ
--     пишутся: адрес ИП — домашний адрес человека, и закон его на витрине не
--     требует (lib/tours/seller-requisites). Снимок выписки в репозиторий не
--     кладётся.
--   • Страхование пассажиров — со слов перевозчика; полиса владелец не
--     присылал, и страница говорит «полис на платформе не показан».
--   • is_verified = FALSE — «только факты» (владелец 15.10): отметку даёт
--     администратор, а не миграция.
--
-- ── Фото и связь ──────────────────────────────────────────────────────────
--
-- Четыре живых снимка машин (public/images/zheltukhin/zheltukhin-01..04.jpg):
-- Sprinter с салоном, второй Sprinter с салоном, Ford Transit сзади и спереди.
-- Не взяты: снимок группы туристов (их согласия нет), рекламный коллаж с
-- вулканами (не снимок машины) и выписка (паспорт и адрес). Кадры заново
-- закодированы без EXIF. Номер +7 961 962-08-26 — со слов перевозчика, звонок;
-- Telegram и WhatsApp не названы, и ссылок на них нет. В ответы Кузьмича и MCP
-- номер не уходит — только ссылка на страницу (152-ФЗ).
--
-- Рейтинг 0 и review_count 0 — как у «Шатуна» (1185): «не оценён», а не NULL.
--
-- Идемпотентна: ограничения пересоздаются по имени, партнёр — по slug, машины
-- и цены — по ключу; повтор ничего не плодит и не перетирает правки
-- администратора.

BEGIN;

-- Машина без записанного числа мест: NULL — «не записано», а не ноль.
ALTER TABLE transfer_fleet_vehicles ALTER COLUMN seats DROP NOT NULL;

ALTER TABLE transfer_charter_prices DROP CONSTRAINT IF EXISTS transfer_charter_prices_line_kind_check;
ALTER TABLE transfer_charter_prices
  ADD CONSTRAINT transfer_charter_prices_line_kind_check
  CHECK (line_kind IN ('destination', 'extra_day', 'per_hour', 'per_day'));

ALTER TABLE transfer_charter_prices DROP CONSTRAINT IF EXISTS transfer_charter_prices_line_shape;
ALTER TABLE transfer_charter_prices
  ADD CONSTRAINT transfer_charter_prices_line_shape CHECK (
    (line_kind = 'destination' AND from_text IS NOT NULL AND to_text IS NOT NULL)
    OR (line_kind IN ('extra_day', 'per_hour', 'per_day') AND from_text IS NULL AND to_text IS NULL)
  );

-- Один тариф за час и один за день на тип машины.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_charter_prices_rate
  ON transfer_charter_prices (partner_id, vehicle_kind, line_kind)
  WHERE line_kind IN ('per_hour', 'per_day');

INSERT INTO partners (
  slug, name, category,
  short_description, description,
  contact, contacts, location, legal_info,
  hero_image, gallery,
  rating, review_count, is_verified, is_public, created_at
)
SELECT
  'zheltukhin',
  'ИП Желтухин',
  'transfer',
  'Микроавтобусы Mercedes-Benz Sprinter и Ford Transit под заказ — целой машиной, на часы или на полный день; куда ехать, задаёте вы.',
  'Перевозчик: три микроавтобуса — два Mercedes-Benz Sprinter и Ford Transit. Работает под заказ, целой машиной: '
    || 'цена — за час работы машины или за полный день, фиксированных направлений нет, дальние поездки оговариваются отдельно. '
    || 'Ведар оплату не принимает: заказ и расчёт — напрямую с перевозчиком.',
  jsonb_build_object('phone', '+79619620826'),
  jsonb_build_object('phone', '+79619620826'),
  jsonb_build_object('region', 'Камчатский край'),
  jsonb_build_object(
    'companyName', 'ИП Желтухин Михаил Анатольевич',
    'inn',         '410209072036',
    'ogrn',        '313417727300072',
    'license', jsonb_build_object(
      'number',            'Л022-00112-41/00927020',
      'issuedOn',          '2023-11-29',
      'authority',         'Территориальный отдел государственного автодорожного надзора по Камчатскому краю',
      'registryStatus',    'действует',
      'registryCheckedOn', '2026-05-04',
      'source',            'выписка из реестра лицензий'
    ),
    'passengerInsurance', 'со слов перевозчика'
  ),
  '/images/zheltukhin/zheltukhin-01.jpg',
  jsonb_build_array(
    '/images/zheltukhin/zheltukhin-02.jpg',
    '/images/zheltukhin/zheltukhin-03.jpg',
    '/images/zheltukhin/zheltukhin-04.jpg'
  ),
  0, 0, FALSE, TRUE, NOW()
WHERE NOT EXISTS (SELECT 1 FROM partners WHERE slug = 'zheltukhin');

-- Номер на табличке — чтобы различать две одинаковые модели в кабинете; он и
-- так виден на снимках. На публичных страницах парк называется видом машин.
INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats)
SELECT p.id, 'minibus', v.title, NULL
  FROM partners p
  CROSS JOIN (VALUES
    ('Mercedes-Benz Sprinter, В688НУ41'),
    ('Mercedes-Benz Sprinter, В333АС41'),
    ('Ford Transit, К002ОВ41')
  ) AS v(title)
 WHERE p.slug = 'zheltukhin'
   AND NOT EXISTS (
     SELECT 1 FROM transfer_fleet_vehicles f
      WHERE f.partner_id::text = p.id::text AND f.title = v.title
   );

INSERT INTO transfer_charter_prices
  (partner_id, vehicle_kind, line_kind, price_rub, conditions, valid_year, sort_order)
SELECT p.id, 'minibus', v.line_kind, v.price_rub,
       'фиксированных направлений нет; дальние поездки — по договорённости', NULL, v.sort_order
  FROM partners p
  CROSS JOIN (VALUES
    ('per_hour', 4500, 10),
    ('per_day', 45000, 20)
  ) AS v(line_kind, price_rub, sort_order)
 WHERE p.slug = 'zheltukhin'
   AND NOT EXISTS (
     SELECT 1 FROM transfer_charter_prices c
      WHERE c.partner_id::text = p.id::text AND c.vehicle_kind = 'minibus' AND c.line_kind = v.line_kind
   );

-- Исход называется вслух: ровно один партнёр, три машины, две строки прайса.
DO $$
DECLARE
  v_partner int;
  v_cars    int;
  v_prices  int;
BEGIN
  SELECT count(*) INTO v_partner FROM partners WHERE slug = 'zheltukhin' AND category = 'transfer';
  SELECT count(*) INTO v_cars FROM transfer_fleet_vehicles f JOIN partners p ON p.id::text = f.partner_id::text
   WHERE p.slug = 'zheltukhin' AND f.is_active;
  SELECT count(*) INTO v_prices FROM transfer_charter_prices c JOIN partners p ON p.id::text = c.partner_id::text
   WHERE p.slug = 'zheltukhin' AND c.is_active;
  IF v_partner <> 1 OR v_cars <> 3 OR v_prices <> 2 THEN
    RAISE WARNING '[1292] «ИП Желтухин»: партнёров %, машин % (нужно 3), строк прайса % (нужно 2); запись могла быть заведена раньше из админки', v_partner, v_cars, v_prices;
  END IF;
END $$;

COMMIT;
