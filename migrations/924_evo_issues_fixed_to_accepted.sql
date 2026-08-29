-- 924: находки эволюции со статусом 'fixed' → 'accepted'.
--
-- syncClosedIssues() в app/api/cron/evo-report/route.ts писал в
-- evo_growth_issues.status значение 'fixed' для находок, чей GitHub issue
-- человек закрыл как completed. Словарь дашборда (getEvoStats,
-- EVO_ISSUE_STATUSES в lib/agents/evo/feedback-loop.ts) знает только
-- open/suggested/accepted/rejected/ignored — 'fixed' в него не входил
-- никогда. Находки писались исправно, но пропадали из счётчика
-- «Исправлено»: писатель и читатель статуса разошлись молча.
--
-- Это та же болезнь мёртвых цифр, что уже чинили для другого писателя
-- того же поля (комментарий в feedback-loop.ts, guard
-- evo-stats-honesty.test.ts) — вернулась другим путём и осталась
-- незамеченной, потому что тот guard сканировал только один файл-писатель.
--
-- Backfill переносит уже накопленные в проде строки на канонический статус:
-- 'accepted' — тот же, что ставит evolution-loop для автофиксов. Разных
-- смыслов у «человек подтвердил на GitHub» и «двигатель сам применил» для
-- счёта точности нет: оба значат «находка была верной, и по ней что-то
-- сделано».

UPDATE evo_growth_issues
   SET status = 'accepted'
 WHERE status = 'fixed';
