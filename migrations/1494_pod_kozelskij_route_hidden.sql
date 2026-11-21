-- 1494_pod_kozelskij_route_hidden.sql
--
-- Пустая карточка «Под Козельский вулкан» уходит с витрины (#3566 п.1, слово
-- владельца 21.11: «1 скрыть»).
--
-- Сверка дублей Козельского (MCP fetch, 21.11): три маршрута к одному
-- вулкану — разные пути, а не копии. «Подножье Козельского вулкана»
-- (visitkamchatka-kozel-volcano-summer: 80 км, летний, паспорт) и «Вулкан
-- Козельский» (vulkan-kozelskiy-a5161175: восхождение, 3,3 км, 1276 м)
-- остаются. Третий — «Под Козельский вулкан» (pod-kozelskij-vulkan-marshrut:
-- 9,3 км, 534 м) — без описания: человеку на нём нечего прочесть, а в выдаче
-- он соперничает с двумя настоящими.
--
-- Скрытие, а не удаление и не слияние: путь не тот же, что у оставшихся, и
-- merged_into_id назвал бы его копией. Адрес из выдачи ведёт 308 на карточку
-- места «Козельский» (next.config.js) — с неё видны маршруты и туры.
--
-- Скрывается, только если на маршрут не ссылается ни один тур: тур с
-- маршрутом-призраком показал бы ссылку в никуда. Откат — is_visible = true.
-- Идемпотентна.

UPDATE kamchatka_routes r
SET is_visible = false,
    updated_at = NOW()
WHERE r.slug = 'pod-kozelskij-vulkan-marshrut'
  AND r.is_visible = true
  AND r.merged_into_id IS NULL
  AND (r.description IS NULL OR btrim(r.description) = '')
  AND NOT EXISTS (
    SELECT 1 FROM operator_tours t WHERE t.route_id::text = r.id::text
  );
