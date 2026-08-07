-- 834: Соцсети партнёра «Камчатская рыбалка» — Telegram-канал и TikTok.
--
-- Источник: владелец, 07.08.2026 — «у нас есть тик ток аккаунт: kamfishing41,
-- https://t.me/KamFishing_41». Живой канал с уловами — сигнал доверия на
-- карточке тура; кнопки рендерит toContacts (telegram_channel/tiktok).
--
-- Идемпотентно: jsonb-мерж перезаписывает те же ключи теми же значениями.

UPDATE partners
   SET contacts = COALESCE(contacts, '{}'::jsonb) || jsonb_build_object(
         'telegram_channel', 'https://t.me/KamFishing_41',
         'tiktok', 'kamfishing41'
       ),
       updated_at = NOW()
 WHERE name = 'Камчатская рыбалка';
