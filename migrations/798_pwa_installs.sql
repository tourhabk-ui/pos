-- Migration 798: учёт установок PWA
--
-- Платформа не считала, сколько раз приложение поставили на телефон — а это
-- ключевая метрика для offline-first продукта. Считаем УСТРОЙСТВА (а не сырые
-- события): дедуп по анонимному client_id из localStorage (случайный UUID,
-- не ПД — ни телефона, ни почты, ни имени, вне действия PII-гардов §8).
--
-- Два честных сигнала пишут сюда:
--   • appinstalled — событие браузера при установке (Android/Chrome);
--   • standalone-launch — запуск уже установленного приложения (единственный
--     способ увидеть iOS Safari, который appinstalled НЕ шлёт).
-- Итого COUNT(*) = число устройств, у которых приложение установлено и
-- открывалось. Это нижняя граница (не все браузеры шлют сигналы), и врать
-- «точным числом скачиваний» нельзя — метрика честно про открывавшие устройства.
--
-- Идемпотентна.

CREATE TABLE IF NOT EXISTS pwa_installs (
  client_id      TEXT PRIMARY KEY,
  platform       TEXT,
  install_source TEXT,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwa_installs_first_seen ON pwa_installs (first_seen);
