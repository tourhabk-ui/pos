-- 1318: «Лагуна Прокат» — партнёр на двух витринах: перевозчик на /transfers
-- (микроавтобус и вахтовка с водителем, цена за машину за сутки) и прокатчик
-- на /car-rental (машины без водителя, схема 1317).
--
-- Решение владельца 23.10: «пока берем аренду автомобилей и трансфер» — из
-- группы «Лагуна» (СПА-отель «Лагуна», Паратунка) берём прокат и трансферы.
-- Связь с контактом группы — MAX и Telegram через владельца; номер контакта
-- в репозиторий не пишется.
--
-- ── Источник каждой цифры ─────────────────────────────────────────────────
--
-- Источник: сайт прокатчика лагунапрокат.рф — главная и страницы машин
-- /rent/suzuki, /rent/tank300, /rent/sever, /rent/ford, /rent/ural; снято
-- 23.10.2026 (docs/partners/blue-lagoon-call.md, «Итог 23.10»). Телефон
-- +7 906 083-50-70, почта prokatlaguna@yandex.ru, ссылки MAX и Telegram и
-- адрес «Елизовский район, с. Паратунка, ул. Невельского, 6» — оттуда же, из
-- раздела контактов. Это контакты фирмы с её сайта, не номер человека.
--
-- Где главная и страница машины расходятся, записано осторожное: на главной
-- Ford Transit и Sever Truck — «от 25 000» и «от 35 000 руб/сутки», на
-- страницах машин — «25 000» и «35 000». Записано «от» (price_is_from /
-- price_note), точную цену называет прокатчик.
--
-- ── Почему две витрины, и что куда ────────────────────────────────────────
--
-- Трансфер на Ведаре — машина целиком с водителем (§14, 13.10). На сайте две
-- машины едут с водителем:
--   • Ford Transit, 17 мест, механика, 100 л.с.: «*Водитель входит в
--     стоимость аренды» — строка прайса per_day, 25 000 ₽ за машину за сутки;
--   • Урал ГИРД (вахтовка), 25 мест: в карточке «Профессиональный водитель» и
--     «Разрешительная документация на перевозку людей» — строка per_day
--     от 50 000 ₽; входит ли водитель в цену, сайт не говорит — так и
--     записано в conditions.
-- Три машины сдаются без водителя — это прокат (car_rental_offers):
--   • Suzuki Jimny: 4 места, автомат, 4WD, 105 л.с., 7 000 ₽/сутки, залог 15 000;
--   • Tank-300: 5 мест, автомат, 4WD, 220 л.с., 15 000 ₽/сутки, залог 30 000;
--   • Sever Truck: 8 мест, механика, 4WD, 120 л.с., от 35 000 ₽/сутки, залог
--     50 000; «*Возможно аренда с водителем» — driver = optional, цена
--     водителя не названа и не выдумывается; в цену входят маршруты к
--     памятнику «Здесь начинается Россия», на реку Быструю и в посёлок
--     Термальный, за доплату — Вилючинский и Авачинский перевалы,
--     Карымшинские источники и подножие Горелого (сумма доплаты не названа).
-- Условия проката (car_rental_terms) — пункты FAQ сайта, своими словами без
-- добавлений: залог и удержание 5 000 ₽ на 14 рабочих дней, предоплата,
-- подача в аэропорт, топливо, детское кресло, снаряжение, категории маршрутов
-- и запрещённые направления, свой водитель прокатчика.
--
-- ── Чего НЕТ, и это не забывчивость (§4.0) ────────────────────────────────
--
--   • Юрлицо, ИНН, ОГРН — сайт проката не называет; legal_info NULL,
--     страница говорит «реквизиты на платформе не записаны». Реквизиты
--     ООО «Экспедиция» с сайта туров сюда не переносятся: что прокат ведёт
--     то же лицо, не подтверждено.
--   • Фото — нет: согласия на снимки не было (hero_image NULL, gallery пуста).
--   • is_verified FALSE — отметку ставит администратор, не миграция.
--   • Трансферы «Лагуна Экспедиции» — за человека, не за машину: строк прайса
--     по ним нет до ответа о ценах за машину (§14).
--   • Минимальный срок, возраст и стаж, страховка, год и пробег — на сайте
--     не названы, колонок под это нет.
--   • valid_year у строк прайса NULL: год прайса сайт не называет.
--
-- Категория партнёра — transfer: страница /transfers/[slug] требует её, а
-- витрина проката берёт партнёра по наличию прайса проката, без категории.
-- Рейтинг 0 и review_count 0 — «не оценён», как у 1185 и 1292.
--
-- Идемпотентна: партнёр — по slug, машины, строки прайса, предложения проката
-- и условия — по ключу; повтор ничего не плодит и не перетирает правки
-- администратора. Сравнения id — в текстовом домене (урок 874).

BEGIN;

INSERT INTO partners (
  slug, name, category,
  short_description, description,
  contact, contacts, location, legal_info,
  hero_image, gallery,
  rating, review_count, is_verified, is_public, created_at
)
SELECT
  'laguna-prokat',
  'Лагуна Прокат',
  'transfer',
  'Машины напрокат без водителя и микроавтобус с водителем — целой машиной за сутки. База в Паратунке, у СПА-отеля «Лагуна».',
  'Прокат при СПА-отеле «Лагуна» в Паратунке. Без водителя: Suzuki Jimny, Tank-300 и вездеход Sever Truck '
    || '(его можно взять и с водителем — цену водителя называет прокатчик). С водителем, целой машиной за сутки: '
    || 'Ford Transit на 17 мест и вахтовка «Урал» на 25 мест. Топливо — за счёт арендатора, подача в аэропорт — '
    || 'по согласованию. Ведар оплату не принимает: заказ и расчёт — напрямую с прокатчиком.',
  jsonb_build_object('phone', '+79060835070'),
  jsonb_build_object(
    'phone',            '+79060835070',
    'telegram_contact', '+79060835070',
    'max',              'https://max.ru/u/f9LHodD0cOL5hfoE3T4JU-cV1IjhDWQnsG7ILCa6i1QjHaiqgEgfz8np4DM',
    'email',            'prokatlaguna@yandex.ru',
    'website',          'https://лагунапрокат.рф/'
  ),
  jsonb_build_object(
    'region',  'Камчатский край',
    'address', 'Елизовский район, с. Паратунка, ул. Невельского, 6'
  ),
  NULL,
  NULL,
  '[]'::jsonb,
  0, 0, FALSE, TRUE, NOW()
WHERE NOT EXISTS (SELECT 1 FROM partners WHERE slug = 'laguna-prokat');

-- Парк перевозчика: две машины с водителем, места — с сайта.
INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats)
SELECT p.id, v.kind, v.title, v.seats
  FROM partners p
  CROSS JOIN (VALUES
    ('minibus',  'Ford Transit',          17),
    ('vahtovka', 'Урал ГИРД (вахтовка)',  25)
  ) AS v(kind, title, seats)
 WHERE p.slug = 'laguna-prokat'
   AND NOT EXISTS (
     SELECT 1 FROM transfer_fleet_vehicles f
      WHERE f.partner_id::text = p.id::text AND f.title = v.title
   );

-- Цена за машину за сутки (per_day, 1292): направлений у прокатчика нет,
-- куда ехать — задаёт заказчик.
INSERT INTO transfer_charter_prices
  (partner_id, vehicle_kind, line_kind, price_rub, price_note, conditions, valid_year, sort_order)
SELECT p.id, v.vehicle_kind, 'per_day', v.price_rub, v.price_note, v.conditions, NULL, v.sort_order
  FROM partners p
  CROSS JOIN (VALUES
    ('minibus', 25000,
     'цена «от» — точную назовёт перевозчик',
     'водитель входит в стоимость — по сайту перевозчика; подача, топливо и число часов в сутках не названы',
     10),
    ('vahtovka', 50000,
     'цена «от» — точную назовёт перевозчик',
     'профессиональный водитель и разрешительная документация на перевозку людей — по сайту перевозчика; входит ли водитель в цену, не сказано',
     20)
  ) AS v(vehicle_kind, price_rub, price_note, conditions, sort_order)
 WHERE p.slug = 'laguna-prokat'
   AND NOT EXISTS (
     SELECT 1 FROM transfer_charter_prices c
      WHERE c.partner_id::text = p.id::text AND c.vehicle_kind = v.vehicle_kind AND c.line_kind = 'per_day'
   );

-- Машины без водителя — прокат (схема 1317).
INSERT INTO car_rental_offers
  (partner_id, title, body_kind, seats, transmission, drive, engine_hp,
   price_rub_per_day, price_is_from, deposit_rub, driver, conditions, source_url, prices_seen_on, sort_order)
SELECT p.id, v.title, v.body_kind, v.seats, v.transmission, v.drive, v.engine_hp,
       v.price_rub_per_day, v.price_is_from, v.deposit_rub, v.driver, v.conditions, v.source_url, DATE '2026-10-23', v.sort_order
  FROM partners p
  CROSS JOIN (VALUES
    ('Suzuki Jimny', 'suv', 4, 'automatic', '4wd', 105,
     7000, FALSE, 15000, 'self', NULL,
     'https://лагунапрокат.рф/rent/suzuki', 10),
    ('Tank-300', 'suv', 5, 'automatic', '4wd', 220,
     15000, FALSE, 30000, 'self', NULL,
     'https://лагунапрокат.рф/rent/tank300', 20),
    ('Sever Truck', 'offroad_truck', 8, 'manual', '4wd', 120,
     35000, TRUE, 50000, 'optional',
     'В цену входят маршруты: памятник «Здесь начинается Россия», река Быстрая, посёлок Термальный. '
       || 'За доплату: Вилючинский перевал, Карымшинские источники, Авачинский перевал, подножие Горелого — сумма не названа. '
       || 'Аренда с водителем возможна, цена водителя — отдельно, у прокатчика.',
     'https://лагунапрокат.рф/rent/sever', 30)
  ) AS v(title, body_kind, seats, transmission, drive, engine_hp,
         price_rub_per_day, price_is_from, deposit_rub, driver, conditions, source_url, sort_order)
 WHERE p.slug = 'laguna-prokat'
   AND NOT EXISTS (
     SELECT 1 FROM car_rental_offers o
      WHERE o.partner_id::text = p.id::text AND o.title = v.title
   );

-- Условия проката — пункты FAQ сайта.
INSERT INTO car_rental_terms (partner_id, items, source_url, seen_on)
SELECT p.id,
       ARRAY[
         'Залог возвращается после осмотра машины; 5 000 ₽ из него удерживаются на 14 рабочих дней под возможные штрафы ГИБДД и без штрафов возвращаются на карту.',
         'Предоплата — при бронировании от 4 дней и при подаче машины в аэропорт.',
         'Подача в аэропорт — по согласованию с менеджером при бронировании.',
         'Топливо — за счёт арендатора.',
         'Детское кресло — бесплатно, по предварительной просьбе.',
         'Походное снаряжение — 5 000 ₽ независимо от машины, маршрута и срока.',
         'Маршруты: лёгкие входят в цену, средние — 10 000 ₽, тяжёлые — 15 000 ₽. Запрещены: Усть-Камчатск, Крутоберегово, Соболево, Озерновский, Шумный, каньон Опасный.',
         'Нет прав нужной категории — прокатчик даёт своего водителя, который ведёт машину и сопровождает; цена зависит от маршрута и называется отдельно.'
       ],
       'https://лагунапрокат.рф/',
       DATE '2026-10-23'
  FROM partners p
 WHERE p.slug = 'laguna-prokat'
   AND NOT EXISTS (
     SELECT 1 FROM car_rental_terms t WHERE t.partner_id::text = p.id::text
   );

-- Исход называется вслух: один партнёр, две машины с водителем, две строки
-- прайса, три предложения проката, одна запись условий.
DO $$
DECLARE
  v_partner int;
  v_cars    int;
  v_prices  int;
  v_offers  int;
  v_terms   int;
BEGIN
  SELECT count(*) INTO v_partner FROM partners
   WHERE slug = 'laguna-prokat' AND category = 'transfer';
  SELECT count(*) INTO v_cars FROM transfer_fleet_vehicles f JOIN partners p ON p.id::text = f.partner_id::text
   WHERE p.slug = 'laguna-prokat' AND f.is_active;
  SELECT count(*) INTO v_prices FROM transfer_charter_prices c JOIN partners p ON p.id::text = c.partner_id::text
   WHERE p.slug = 'laguna-prokat' AND c.is_active;
  SELECT count(*) INTO v_offers FROM car_rental_offers o JOIN partners p ON p.id::text = o.partner_id::text
   WHERE p.slug = 'laguna-prokat' AND o.is_active;
  SELECT count(*) INTO v_terms FROM car_rental_terms t JOIN partners p ON p.id::text = t.partner_id::text
   WHERE p.slug = 'laguna-prokat';
  IF v_partner <> 1 OR v_cars <> 2 OR v_prices <> 2 OR v_offers <> 3 OR v_terms <> 1 THEN
    RAISE WARNING '[1318] «Лагуна Прокат»: партнёров %, машин % (нужно 2), строк прайса % (нужно 2), предложений проката % (нужно 3), условий % (нужно 1); запись могла быть заведена раньше из админки',
      v_partner, v_cars, v_prices, v_offers, v_terms;
  END IF;
END $$;

COMMIT;
