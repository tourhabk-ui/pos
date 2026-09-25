-- 1027: агенты, прошедшие онбординг, — в очередь одобрения.
--
-- Решение владельца 26.09: агент работает только после одобрения
-- администратором. Завершение онбординга агента с этого дня подаёт заявку
-- (profile_status 'none' → 'pending', app/api/partners/profile) — как у гида
-- с миграции 1019. Эта миграция делает то же для тех, кто прошёл онбординг
-- раньше: иначе они остались бы в 'none', вне очереди /hub/admin/operators,
-- и одобрять было бы некого.
--
-- Отбор узкий: только записи агентов с аккаунтом, завершившие онбординг и
-- ещё не подававшие заявку. applied_at — момент последней правки записи:
-- точная дата завершения онбординга не записывалась, и выдумывать её нельзя.

UPDATE partners
   SET profile_status = 'pending',
       applied_at     = COALESCE(applied_at, updated_at::timestamp)
 WHERE category = 'agent'
   AND user_id IS NOT NULL
   AND onboarding_completed = TRUE
   AND profile_status = 'none';
