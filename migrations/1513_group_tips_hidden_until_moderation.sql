-- Migration 1513: советы туристов из Telegram-групп — скрыты до модерации
-- Created: 2026-11-25
--
-- Скан безопасности 25.11. Монитор Telegram-групп
-- (lib/telegram/group-monitor.ts, saveToKnowledgeBase) писал советы в
-- kamchatka_routes сразу видимыми (is_visible = true), а бот слушает любую
-- группу, куда его добавили. Поиск Кузьмича (lib/ai/route-knowledge.ts) берёт
-- видимые строки как данные платформы — значит, совет из чужой группы, в том
-- числе про безопасность маршрута, уходил туристу как проверенный.
-- Писатель с этого PR ставит is_visible = false; здесь скрываются уже
-- записанные советы. Ни один из них модерацию не проходил: видимыми их делал
-- сам писатель. Строки не удаляются — администратор открывает нужные.
--
-- Идемпотентно: повтор не находит видимых советов групп.

BEGIN;

UPDATE kamchatka_routes
   SET is_visible = false,
       updated_at = NOW()
 WHERE is_visible = true
   AND category = 'tourist_tip'
   AND metadata->>'source' = 'telegram_group';

COMMIT;
