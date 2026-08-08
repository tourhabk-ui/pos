-- 843: Индексы горячих путей агентского каталога и занятости.
--
-- Перф-аудит владельца 08.08 (пп. 2-3 по ROI): после починки каталога
-- (#1048) узкое место смещается на availability — fetchAvailabilityForTour
-- делает LATERAL-агрегат по operator_bookings НА КАЖДУЮ дату окна (до 31),
-- этим же путём ходят гейт брони, MCP и share-API плана. Без индексов при
-- росте броней конверсионный путь станет первым тормозом.
--
-- CONCURRENTLY: migrate-раннер определяет такие файлы и применяет их
-- statement-by-statement вне транзакции. Идемпотентно (IF NOT EXISTS).

-- Слоты тура по дате (fetchAvailabilityForTour, /api/tours/[id]/slots)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tour_availability_tour_date
  ON tour_availability (operator_tour_id, date)
  WHERE is_cancelled = FALSE AND deleted_at IS NULL;

-- Сумма участников по активным броням даты (LATERAL занятости; условие
-- совпадает с запросом: booking_status NOT IN ('cancelled','rejected'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_bookings_tour_date_active
  ON operator_bookings (operator_tour_id, booking_date)
  WHERE booking_status NOT IN ('cancelled', 'rejected');

-- Витринный каталог (buildTourContext/get_tours, sitemap, llms.txt):
-- ORDER BY base_price по опубликованным активным без сортировки на лету
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_operator_tours_catalog
  ON operator_tours (base_price ASC NULLS LAST)
  WHERE is_active = TRUE AND deleted_at IS NULL AND is_published = TRUE;

-- База знаний Кузьмича: свежие записи агента без сортировки на лету
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_knowledge_agent_updated
  ON agent_knowledge (agent_id, updated_at DESC);
