-- 708: trail_reports — наблюдения туристов с маршрутов (медведь, камнепад, погода).
-- Юзер-репорты НЕ смешиваются с официальными данными КБГС/МЧС: в UI показываются
-- только status='approved' и всегда с бейджем «наблюдение туриста, не проверено».
-- Модерация: pending → approved/rejected руками владельца (SQL или админка позже).

CREATE TABLE IF NOT EXISTS trail_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type  VARCHAR(20) NOT NULL CHECK (report_type IN ('bear', 'rockfall', 'weather', 'other')),
  text         TEXT NOT NULL CHECK (LENGTH(text) BETWEEN 3 AND 500),
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  user_id      UUID,
  status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Выборка для радара: последние approved
CREATE INDEX IF NOT EXISTS idx_trail_reports_status_created
  ON trail_reports (status, created_at DESC);
