-- 1306: запрос мест (tour_seat_requests, 1108) — события в журнал crm_events.
--
-- Пилот «Камчатская рыбалка» (владелец 22.10, «тест сначала»): цикл «запрос →
-- кнопка оператора в MAX → исход → туристу» работает, но следа в журнале не
-- оставлял: отказ, просрочка, недоставка и отправка туристу не записывались.
--
-- Запрос мест НЕ становится источником клиента (crm_contact_links не
-- трогается): до «Есть места» оператор туриста не знает (сторож
-- tests/unit/crm-pd-parity.test.ts). Поэтому события пишутся без клиента —
-- contact_id NULL схема 1196 разрешает, — а в payload только статусы, дата,
-- число людей и канал. Лента клиента (listContactEvents) их не показывает; когда
-- «Есть места» заводит бронь, клиент появляется через бронь, как и раньше.
--
-- Здесь — только новый вид в проверке source_kind ленты. Идемпотентна.

BEGIN;

ALTER TABLE crm_events DROP CONSTRAINT IF EXISTS crm_events_source_kind_check;
ALTER TABLE crm_events ADD CONSTRAINT crm_events_source_kind_check CHECK (source_kind IS NULL OR source_kind IN (
  'operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking',
  'lead', 'agent_client', 'seat_request'
));

COMMIT;
