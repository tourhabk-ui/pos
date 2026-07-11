-- 743: Закрыть фантомные issues Evo-сканера.
--
-- Growth-агент репортил проблемы по захардкоженным спискам (аудит апреля
-- 2026), которые устарели: 10 «мёртвых модулей» и оба временных эндпоинта
-- давно удалены из репо, а experiment-tracker, context-hub и
-- observation-logger снова используются (eval-модули, platform-agent).
-- Записи о них висели в evo_growth_issues и раздували Telegram-алерт
-- («18 проблем») каждый скан. Код-списки очищены в этом же PR; здесь
-- закрываем накопленные строки в БД.
--
-- Идемпотентно: повторный прогон не находит строк для обновления.

UPDATE evo_growth_issues
SET status = 'rejected'
WHERE status IN ('open', 'suggested', 'accepted')
  AND category IN ('dead_code', 'tech_debt')
  AND file_path IN (
    -- удалены из репо
    'lib/agents/learning/feedback-loop.ts',
    'lib/agents/learning/pattern-recognition.ts',
    'lib/agents/evolution/optimized-runner.ts',
    'lib/agents/execution/evolution-loop.ts',
    'lib/agents/execution/vibe-coder-executor.ts',
    'lib/agents/sdk/evo-sdk-agent.ts',
    'lib/agents/sdk/hacker-sdk-agent.ts',
    'lib/agents/sdk/rescue-sdk-agent.ts',
    'lib/agents/validation/director-standards.ts',
    'lib/legal/ai-legal-review.ts',
    'app/api/admin/run-089/route.ts',
    'app/api/admin/run-115/route.ts',
    -- снова живые (импортируются)
    'lib/agents/learning/experiment-tracker.ts',
    'lib/agents/context-hub.ts',
    'lib/agents/observation-logger.ts'
  );
