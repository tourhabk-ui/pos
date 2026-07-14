-- 745: закрыть выдуманные AI-ревью issues Evo Scan (12.07.2026)
--
-- aiCodeReview отправлял модели только ИМЕНА файлов без содержимого —
-- все bug-issues по lib/kuzmich/core.ts выдуманы и опровергнуты вручную:
--   * «import pool from '@/lib/db' строка 60» — в коде import { pool }
--     from '@/lib/db-pool' (строка 11), дефолтного импорта нет;
--   * «callDeepSeek без try/catch строка 150» — callDeepSeek в файле
--     отсутствует вовсе, try/catch в файле 27 штук;
--   * «Файл не предоставлен для анализа... Пропускаю» — отговорка модели,
--     записанная как проблема.
-- Конвейер починен (контент файлов в промпте + мусор-фильтр + кап на файл),
-- эти записи закрываем как rejected, чтобы алерты не пугали владельца.

UPDATE evo_growth_issues
SET status = 'rejected'
WHERE status IN ('open', 'suggested')
  AND category = 'bug'
  AND file_path = 'lib/kuzmich/core.ts';
