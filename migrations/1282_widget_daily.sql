-- Migration 1282: измеримость виджетов партнёров (аудит 15.10, находка
-- WID-measure; карт-бланш владельца 15.10)
-- Created: 2026-10-15
--
-- На вопрос «стоит ли виджет на сайте партнёра и пользуются ли им» ответа не
-- было: скрипты на чужом сайте ничего не сообщали, домен страницы не
-- записывался нигде, переписи не было. Проверка шла ручным curl главной.
--
-- widget_daily — счёт по дням (день по Камчатке) на партнёра, хост страницы
-- и род виджета:
--
--   widget = 'form'  — кнопка заявки (/api/widget/lead.js);
--   widget = 'chat'  — окно чата (public/widget/embed.js).
--
--   served — сколько раз сервер ВЫДАЛ скрипт формы (lead.js, хост — из
--            Referer). Нижняя граница просмотров: браузер держит скрипт
--            5 минут, боты не считаются. У чата NULL по построению: embed.js —
--            статический файл, его выдачу сервер не видит, и ноль здесь был бы
--            ложью «не выдавался ни разу» (§4.0). CHECK держит это различие.
--   opened — сколько раз посетитель открыл окно (маяк POST /api/widget/event
--            по первому клику на странице).
--
-- host — как прислал браузер; NULL — не прислан (Referer срезан политикой
-- сайта). Подделывается кем угодно: это сигнал для счёта, а не замок, и
-- ничего по нему не запирается. Сверка со списком widget_domains делается
-- при чтении — список партнёра может меняться.
--
-- NULLS NOT DISTINCT: без него строки без хоста не сходились бы в одну, и
-- каждая выдача без Referer заводила бы новую строку вместо +1 (PG 15+;
-- прод — 18.1).
--
-- chat_sessions.widget_origin — откуда пришёл человек в чат виджета:
-- {host, path, host_check}, host_check — listed / unlisted / not_sent
-- (lib/embed/widget-origin.ts). Путь — без query и hash. NULL — разговор
-- записан до этой миграции или не из виджета. У заявок формы та же запись
-- лежит в leads.source_data.widget_origin — колонка там не нужна.
--
-- Без ПД по построению: ни IP, ни User-Agent, ни текста — только партнёр,
-- день, хост и числа.

CREATE TABLE IF NOT EXISTS widget_daily (
  partner_id  UUID        NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  day         DATE        NOT NULL,
  host        VARCHAR(253),
  widget      VARCHAR(8)  NOT NULL,
  served      INTEGER,
  opened      INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT widget_daily_widget_check CHECK (widget IN ('form', 'chat')),
  CONSTRAINT widget_daily_served_check CHECK (
    (widget = 'form' AND served IS NOT NULL AND served >= 0)
    OR (widget = 'chat' AND served IS NULL)
  ),
  CONSTRAINT widget_daily_opened_check CHECK (opened >= 0),
  CONSTRAINT widget_daily_key UNIQUE NULLS NOT DISTINCT (partner_id, day, host, widget)
);

CREATE INDEX IF NOT EXISTS idx_widget_daily_day ON widget_daily (day DESC);

COMMENT ON TABLE widget_daily IS
  'Виджеты партнёров по дням (Камчатка): выдачи lead.js и открытия окон по хосту страницы. Хост подделываем — сигнал, не замок (аудит 15.10, WID-measure).';
COMMENT ON COLUMN widget_daily.served IS
  'Выдачи скрипта формы сервером (нижняя граница просмотров); у чата NULL — embed.js статика, выдача не видна.';
COMMENT ON COLUMN widget_daily.opened IS
  'Открытия окна виджета (маяк /api/widget/event по первому клику на странице).';

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS widget_origin JSONB;

COMMENT ON COLUMN chat_sessions.widget_origin IS
  'Чат виджета: {host, path, host_check} страницы партнёра; host_check listed/unlisted/not_sent; хост подделываем — сигнал, не замок (аудит 15.10, WID-measure).';
