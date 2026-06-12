-- migrations/678_sos_events_source_relay.sql
-- Трекинг источника SOS: прямой вызов vs ретрансляция через меш-сеть группы.
-- relayed_by — deviceId узла-ретранслятора (WebRTC peer ID, не PII).

ALTER TABLE sos_events
  ADD COLUMN IF NOT EXISTS source     VARCHAR(20) NOT NULL DEFAULT 'direct'
    CHECK (source IN ('direct', 'mesh_relay')),
  ADD COLUMN IF NOT EXISTS relayed_by TEXT;
