-- 1017: гиды, прошедшие онбординг, — в очередь проверки.
--
-- ── Что было ──────────────────────────────────────────────────────────────
-- Публичный реестр /guides отбирал profile_status = 'active', которого CHECK
-- не допускает (none/pending/approved/rejected), — то есть не показывал
-- никого. Решение владельца 25.09: на витрине только гиды, ОДОБРЕННЫЕ
-- платформой (profile_status = 'approved', lib/guides/visibility.ts).
--
-- Одобрять было некого: онбординг гида ставил onboarding_completed и не
-- трогал profile_status, и гид оставался в 'none' — в очереди администратора
-- (/hub/admin/operators, вкладка «На проверке») его не было. С этого PR
-- завершение онбординга гида подаёт заявку ('pending'). Эта миграция делает
-- то же для тех, кто прошёл онбординг раньше.
--
-- Отбор узкий: только гиды с аккаунтом (user_id), завершившие онбординг и
-- ещё не подававшие заявку. Импортированные записи реестра (user_id IS NULL)
-- не трогаются: их никто не заполнял, и в очередь им нечего нести.
-- applied_at — момент последней правки записи: точная дата завершения
-- онбординга не записывалась, и выдумывать её нельзя; updated_at — ближайшее
-- записанное.

UPDATE partners
   SET profile_status = 'pending',
       applied_at     = COALESCE(applied_at, updated_at::timestamp)
 WHERE category = 'guide'
   AND user_id IS NOT NULL
   AND onboarding_completed = TRUE
   AND profile_status = 'none';
