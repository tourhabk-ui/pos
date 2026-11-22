-- 1499_cuks_phones_official_labels.sql
--
-- Сверка 23.11.2026 по официальным страницам ГУ МЧС России по Камчатскому краю:
-- FAQ о контактах при ЧП с туристами и страница регистрации тургрупп.
--
-- 8(4152)200-112 — старший оперативный дежурный ЦУКС (не «резерв»).
-- 8(4152)30-10-89 — начальник дежурной смены ЦУКС (не СОД).
-- 8(4152)30-10-91 — на страницах ведомства не найден, из проверенных убран.
-- 8(4152)30-10-81 — консультации и регистрация групп (не экстренный вызов).
--
-- UI берёт номера из lib/safety/emergency-numbers.ts; реестр и FAQ
-- приводим к тем же подписям, чтобы не разъехались.
-- Идемпотентна.

BEGIN;

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

-- Неподтверждённый номер больше не в проверенных.
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
