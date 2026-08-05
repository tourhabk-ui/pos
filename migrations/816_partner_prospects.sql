-- Migration 816: операторы, которых мы заметили и хотим позвать
--
-- Повод (05.08). Владелец прислал живое объявление оператора «Гамул»:
-- джип-туры, расписание на 6–16 августа с ценами, агентская комиссия 10% —
-- ровно наша ставка. Оператор рабочий, но договорённости с ним нет, и по
-- правилу владельца от 04.08 на витрине только те туры, что партнёры нам
-- предоставили. Ставить чужие туры по объявлению из канала — та самая чужая
-- реклама, которую мы вчера выпиливали из карточки тура.
--
-- Почему не existing operator_applications. Та таблица — про оператора,
-- который ПРИШЁЛ САМ: partner_id и user_id там NOT NULL с внешними ключами,
-- то есть у заявителя уже есть и партнёр, и аккаунт. У «Гамула» нет ни того,
-- ни другого, и заводить их ради записи в блокнот значит создать партнёра,
-- который ни на что не соглашался. (Плюс INSERT в partners — это тот самый
-- приём, что уронил миграцию 806 и стоил трёх дней.)
--
-- Поэтому отдельная таблица без единого внешнего ключа на partners/users:
-- заметка о том, с кем стоит поговорить, а не сущность платформы. Витрина её
-- не читает — сторож tests/unit/partner-prospects.test.ts следит, чтобы так и
-- осталось.

CREATE TABLE IF NOT EXISTS partner_prospects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  -- Откуда узнали: канал, объявление, рекомендация. Без источника заметка
  -- через месяц превращается в «кто это и почему он тут».
  source        TEXT,
  website       TEXT,
  -- Контакты и всё, что оператор сам опубликовал (телефоны, каналы, цены из
  -- анонса). JSONB, потому что состав у каждого свой и схему под него не гнём.
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'agreed', 'declined')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partner_prospects_status ON partner_prospects(status);

-- Уникальность по имени: повторный прогон миграции и повторное добавление
-- того же оператора не плодят дубли.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_prospects_name ON partner_prospects(LOWER(name));

-- ── Первая запись: «Гамул» ────────────────────────────────────────────────────
-- Только то, что оператор опубликовал сам. Ни одной оценки и ни одного вывода
-- от себя: заметка должна пережить меня и остаться проверяемой.
INSERT INTO partner_prospects (name, source, website, details, notes, status)
VALUES (
  'Гамул',
  'Объявление в Telegram-канале оператора, переслано владельцем 05.08.2026',
  'https://gamul-kam.ru',
  jsonb_build_object(
    'phones', jsonb_build_array(
      jsonb_build_object('name', 'Денис', 'phone', '8-914-992-68-65'),
      jsonb_build_object('name', 'Арина', 'phone', '8-914-997-50-88')
    ),
    'telegram', 'https://t.me/gamul_kamcha',
    'vk_reviews', 'https://vk.ru/topic-212306977_48743488',
    'agent_commission_percent', 10,
    'offer', 'Индивидуальные и сборные джип-туры. Забор с адреса, треккинговые палки, хобы и гамаши, горячие обеды.',
    'schedule_august_2026', jsonb_build_array(
      jsonb_build_object('date', '2026-08-06', 'title', 'Восхождение на Авачинский вулкан', 'price', 15000),
      jsonb_build_object('date', '2026-08-06', 'title', 'Мыс Маячный и Три брата', 'price', 10000),
      jsonb_build_object('date', '2026-08-07', 'title', 'Горный массив Вачкажец + Озерки', 'price', 13000),
      jsonb_build_object('date', '2026-08-08', 'title', 'Дачные источники + Снежный Барс', 'price', 14000),
      jsonb_build_object('date', '2026-08-09', 'title', 'Ганальские востряки', 'price', 14000),
      jsonb_build_object('date', '2026-08-10', 'title', 'Мыс Маячный + Три брата', 'price', 10000),
      jsonb_build_object('date', '2026-08-11', 'title', 'Горный массив Вачкажец + Озерки', 'price', 13000),
      jsonb_build_object('date', '2026-08-12', 'title', 'Дачные источники + Снежный барс', 'price', 14000),
      jsonb_build_object('date', '2026-08-13', 'title', 'Восхождение на Горелый вулкан', 'price', 14000),
      jsonb_build_object('date', '2026-08-13', 'title', 'Двухдневный сплав с рыбалкой по р. Быстрая (13–14.08)', 'price', 24000),
      jsonb_build_object('date', '2026-08-14', 'title', 'Горный массив Вачкажец + Озерки', 'price', 13000),
      jsonb_build_object('date', '2026-08-15', 'title', 'Дачные источники + Снежный Барс', 'price', 14000),
      jsonb_build_object('date', '2026-08-16', 'title', 'Восхождение на Авачинский вулкан', 'price', 15000)
    )
  ),
  'Договорённости нет — на витрину не выводим. Комиссия агентам 10% совпадает со ставкой платформы. У нас нет их фотографий и описаний: карточки без снимков не заводим. Их двухдневный сплав по Быстрой (24 000) — не дубль однодневного тура «Камчатка Рафтинг» (13 000); если дойдёт до витрины, длительность обязана стоять в названии, иначе двукратная разница в цене читается как обман.',
  'new'
)
ON CONFLICT (LOWER(name)) DO NOTHING;
