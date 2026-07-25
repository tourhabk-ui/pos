-- 771: атрибуция модели в находках эволюции.
--
-- Зачем: инцидент 24.07 (10 ложных critical про один booking-роут) породил
-- рабочую гипотезу — «галлюцинации из-за слабых фоллбэк-моделей». Проверить её
-- было НЕЧЕМ: callAIDecision молча съезжает с флагмана на DeepSeek/Qwen, если
-- нет ключа или релея, а в находке не хранилось, кто её породил.
--
-- Теперь модель едет вместе с находкой, и точность (accepted/rejected) можно
-- считать ПО МОДЕЛЯМ — гипотеза становится проверяемой на данных, а не спором.
-- 'deterministic' — находки static-checks/мок-детектора (не догадка модели).

ALTER TABLE evo_growth_issues
  ADD COLUMN IF NOT EXISTS model TEXT;

COMMENT ON COLUMN evo_growth_issues.model IS
  'Модель-автор находки (anthropic/claude-opus-5, deepseek-chat, qwen:..., deterministic). NULL — до-атрибуционные записи.';

-- Разрез точности по моделям: какая модель сколько принятых/отвергнутых дала.
CREATE INDEX IF NOT EXISTS idx_evo_growth_issues_model_status
  ON evo_growth_issues (model, status);
