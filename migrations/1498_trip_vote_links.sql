-- Migration 1498: голосование группы по дням сохранённой поездки (фича 6).
-- Created: 2026-11-23
--
-- Слово владельца 23.11 03:42: голос по ссылке БЕЗ входа, итог предлагает
-- заменить день одной кнопкой (заменяет только владелец поездки).
-- Только новые таблицы. Персданных нет: ни телефонов, ни почт, ни IP.
--   trip_vote_links.token_hash — sha256 случайного токена ссылки (сам токен
--     не хранится и не пишется в лог); deadline_at — срок голосования.
--   trip_votes.voter_key — sha256(id ссылки + случайный id из cookie
--     голосующего): связать голос с человеком нельзя.
CREATE TABLE IF NOT EXISTS trip_vote_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID NOT NULL REFERENCES user_trips(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  deadline_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trip_vote_links_trip ON trip_vote_links (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trip_votes (
  link_id    UUID NOT NULL REFERENCES trip_vote_links(id) ON DELETE CASCADE,
  day_num    SMALLINT NOT NULL CHECK (day_num BETWEEN 1 AND 60),
  voter_key  TEXT NOT NULL,
  vote       SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (link_id, day_num, voter_key)
);
