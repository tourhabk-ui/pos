-- 1501_cuks_phones_check_and_retry.sql
--
-- 1500_cuks_phones_official_labels.sql на проде 23.11.2026 упала с SQLSTATE
-- 23514 (file_failed): CHECK из 722 не допускает source='withdrawn' и
-- purpose='not_confirmed'. Транзакция 1500 откатилась целиком, поэтому
-- подписи ЦУКС и FAQ в БД остались прежними. Файл 1500 уже в main и будет
-- повторяться при каждом старте, пока не пройдёт — его не переписываем.
--
-- Здесь расширяем допустимые значения CHECK и повторяем правки данных
-- (идемпотентно). После этого повтор 1500 на следующем старте контейнера
-- должен пройти: те же значения уже разрешены.

BEGIN;

ALTER TABLE emergency_contacts DROP CONSTRAINT IF EXISTS chk_emergency_contacts_source;
ALTER TABLE emergency_contacts
  ADD CONSTRAINT chk_emergency_contacts_source
  CHECK (source IS NULL OR source IN ('code', 'visitkamchatka', 'seed', 'verified', 'withdrawn'));

ALTER TABLE emergency_contacts DROP CONSTRAINT IF EXISTS chk_emergency_contacts_purpose;
ALTER TABLE emergency_contacts
  ADD CONSTRAINT chk_emergency_contacts_purpose
  CHECK (purpose IS NULL OR purpose IN ('emergency', 'registration', 'consultation', 'permit', 'not_confirmed'));

-- 200-112: те же цифры, что у прежней записи 20-01-12.
UPDATE emergency_contacts
   SET name = 'Старший оперативный дежурный ЦУКС МЧС',
       phone = '+7 (4152) 200-112',
       purpose = 'emergency',
       source = 'verified',
       source_url = 'https://41.mchs.gov.ru/feedback_41/chasto-zadavaemye-voprosy/obespechenie-bezopasnosti-turisticheskih-grupp/kakie-kontaktnye-dannye-dlya-svyazi-v-sluchae-ekstrennoy-situacii-s-turistami-v-kamchatskom-krae',
       notes = 'Официально 8(4152)200-112. Сверка 23.11.2026 по FAQ ГУ МЧС о ЧП с туристами. Прежняя запись 20-01-12 — те же цифры, подпись «резерв» снята.',
       verified_at = NOW()
 WHERE source = 'verified'
   AND regexp_replace(phone, '\D', '', 'g') IN ('74152200112', '84152200112');

UPDATE emergency_contacts
   SET name = 'Начальник дежурной смены ЦУКС',
       purpose = 'emergency',
       source = 'verified',
       source_url = 'https://41.mchs.gov.ru/feedback_41/chasto-zadavaemye-voprosy/obespechenie-bezopasnosti-turisticheskih-grupp/kakie-kontaktnye-dannye-dlya-svyazi-v-sluchae-ekstrennoy-situacii-s-turistami-v-kamchatskom-krae',
       notes = 'Официально 8(4152)301089 — начальник дежурной смены ЦУКС. Сверка 23.11.2026.',
       verified_at = NOW()
 WHERE source = 'verified'
   AND regexp_replace(phone, '\D', '', 'g') IN ('74152301089', '84152301089');

UPDATE emergency_contacts
   SET source = 'withdrawn',
       purpose = 'not_confirmed',
       notes = 'Убран 23.11.2026: номер 30-10-91 на официальных страницах ГУ МЧС Камчатки не найден.',
       verified_at = NULL
 WHERE regexp_replace(phone, '\D', '', 'g') IN ('74152301091', '84152301091')
   AND source = 'verified';

UPDATE faqs
   SET answer = 'Ведар даёт туристу кнопку SOS: она есть в шапке каждого экрана vedarai.ru и работает без интернета.

При нажатии SOS:
1. Координаты GPS сохраняются на телефоне — для этого сеть не нужна.
2. Как только появится связь, сигнал с координатами уйдёт дежурному Ведара.
3. В МЧС и горноспасателям сигнал сам не передаётся. В беде звоните 112.

Экстренные номера:
— 112 — спасение, полиция, скорая. Работает без баланса и SIM.
— 101 — пожарные и спасатели МЧС.
— Старший оперативный дежурный ЦУКС МЧС: +7 (4152) 200-112.
— Начальник дежурной смены ЦУКС: +7 (4152) 30-10-89.',
       updated_at = NOW()
 WHERE question = 'Что такое SOS-система на Камчатке?'
   AND (
        answer LIKE '%30-10-91%'
     OR answer LIKE '%резерв +7 (4152) 20-01-12%'
   );

COMMIT;
