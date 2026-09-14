-- 969: согласие на обработку ПД у брони тура (152-ФЗ)
--
-- Замер 14.09: компонент PdConsentCheckbox стоит на ДЕСЯТИ поверхностях —
-- главная, контакты, планер, /request, виджет лид-формы, LeadModal,
-- StickyLeadButton, TourPaymentModal, детали поездки. И не стоит ровно на
-- одной: в components/marketplace/BookingFormClient.tsx, то есть в ГЛАВНОЙ
-- форме заявки на тур, которая собирает имя, телефон и email.
--
-- Хуже того, у второго пути создания брони (app/api/bookings/tour) галочка
-- ЕСТЬ: TourPaymentModal шлёт pd_consent: true. Но в его Zod-схеме такого поля
-- нет, а Zod по умолчанию срезает неизвестные ключи — согласие уходило в
-- никуда. Человек нажимал галочку, и она не записывалась нигде.
--
-- ЭТО ТРЕТЬЯ КОПИЯ одной идеи, и это сказано вслух намеренно. Согласие уже
-- хранится колонками в `users` (миграция 783) и в `leads` (911), и две копии
-- УЖЕ разошлись: у users есть только pd_consent_at и pd_consent_ip, без
-- source и version — то есть у пользователей платформы согласие записано хуже,
-- чем у лидов, и никто этого не заметил. Единая таблица согласий была бы
-- честнее по замыслу, но пока leads и users не переехали, она дала бы не одно
-- место, а ЧЕТВЁРТЫЙ способ. Поэтому здесь копия, а рядом — сторож
-- tests/unit/pd-consent-registry.test.ts с реестром «где живёт согласие»,
-- который может только сокращаться.
--
-- Типы взяты у 911 дословно: копия, которая ещё и разойдётся по типам, хуже
-- копии.
--
-- NULL означает «согласие не зафиксировано», а НЕ «отказано»: бронь может
-- прийти из Кузьмича или виджета, где формы с галочкой нет вовсе. Третье
-- состояние (§4.0 CLAUDE.md) видно и считается, а не выдаётся за согласие.

ALTER TABLE operator_bookings
  ADD COLUMN IF NOT EXISTS pd_consent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pd_consent_ip      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS pd_consent_source  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS pd_consent_version VARCHAR(32);

COMMENT ON COLUMN operator_bookings.pd_consent_at      IS 'Когда дано согласие на обработку ПД. NULL — согласие не зафиксировано (не отказ).';
COMMENT ON COLUMN operator_bookings.pd_consent_ip      IS 'Адрес, с которого дано согласие.';
COMMENT ON COLUMN operator_bookings.pd_consent_source  IS 'Форма/канал, где дано согласие: web-form, tour-payment.';
COMMENT ON COLUMN operator_bookings.pd_consent_version IS 'Версия формулировки согласия (lib/legal/pd-consent.ts).';

-- Отбор броней без зафиксированного согласия — для переписи. Те же соображения,
-- что у 911: их нельзя обрабатывать так же, как остальные, и увидеть их надо
-- одним запросом, а не полным сканом.
CREATE INDEX IF NOT EXISTS idx_operator_bookings_pd_consent_missing
  ON operator_bookings (created_at DESC)
  WHERE pd_consent_at IS NULL;
