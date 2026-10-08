-- 1181: мессенджеры на номере объекта жилья (#2238, «Кутха»).
--
-- Владелец 08.10, после карточки со звонком (1179): «тг, мах, вацап» — то
-- есть на телефоне гостевого дома есть Telegram, MAX и WhatsApp. Колонка
-- хранит, на каких мессенджерах ЗАВЕДЕНО то, что записано в contact_phone.
--
-- Только два вида, и это не упущение:
--   - telegram — ссылка t.me/+<номер>, whatsapp — wa.me/<цифры>: обе строятся
--     из самого номера;
--   - MAX в список не входит. Ссылки по номеру в MAX не существует (проверено
--     09.08, tests/unit/max-contact.test.ts: max.ru/+7… отдаёт 404), адрес
--     ведёт на профиль, и знает его только владелец профиля. Кнопка появится,
--     когда придёт ссылка на профиль; выдуманный адрес был бы мёртвой кнопкой.
--
-- Пустой массив — «ничего не записано», а не «мессенджеров нет». Мессенджеры
-- без номера записать нельзя (проверка в базе): ссылка строится из номера.
--
-- Идемпотентна: колонка IF NOT EXISTS, значение ставится только в пустое.

ALTER TABLE accommodations
  ADD COLUMN IF NOT EXISTS contact_messengers TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accommodations_contact_messengers_known'
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_contact_messengers_known
      CHECK (contact_messengers <@ ARRAY['telegram', 'whatsapp']::text[]);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accommodations_contact_messengers_need_phone'
  ) THEN
    ALTER TABLE accommodations
      ADD CONSTRAINT accommodations_contact_messengers_need_phone
      CHECK (cardinality(contact_messengers) = 0 OR contact_phone IS NOT NULL);
  END IF;
END $$;

UPDATE accommodations
   SET contact_messengers = ARRAY['telegram', 'whatsapp']::text[]
 WHERE LOWER(name) = 'кутха'
   AND contact_phone IS NOT NULL
   AND cardinality(contact_messengers) = 0;
