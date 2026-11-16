-- Migration 1454: снять образцы сообщений Telegram-групп из советов туристов
-- Created: 2026-11-16
--
-- #3433, ревью безопасности #3460. Монитор Telegram-групп
-- (lib/telegram/group-monitor.ts, saveToKnowledgeBase) писал в
-- kamchatka_routes.metadata.sample последние три сообщения группы как есть:
-- «подпись: текст» — с именами и телефонами людей. Читателя у этого ключа нет
-- ни в одном пути; писатель с этого PR его не ставит. Здесь снимается уже
-- записанное — только ключ sample, остальные ключи metadata (маршруты,
-- условия, советы, группа) остаются.
--
-- Идемпотентно: повтор не находит строк с ключом.

BEGIN;

UPDATE kamchatka_routes
   SET metadata = metadata - 'sample',
       updated_at = NOW()
 WHERE metadata ? 'sample'
   AND metadata->>'source' = 'telegram_group';

COMMIT;
