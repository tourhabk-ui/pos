-- 1184: групповое планирование поездки (#2226).
--
-- Решение владельца 08.10: участники по ссылке отмечают свои пожелания, планер
-- сводит их в один маршрут правилом (lib/planner/group-merge). О здоровье —
-- БЕЗ диагнозов: только обезличенные флаги («тяжёлые подъёмы не подходят»,
-- «укачивает», «ограничена подвижность»). Это не особая категория ПД; согласие
-- на обработку данных берётся с каждого участника — pd_consent_at NOT NULL,
-- запись без согласия не создаётся.
--
-- Ни имён, ни телефонов, ни свободного текста: участник — строка флагов.
-- Наружу (страница группы) уходит только сводка, строки участников не
-- отдаются никому (сторож trip-groups-no-member-rows).
--
-- Доступ — знанием id группы (UUID), как у черновиков плана (1182): у
-- анонимной группы нет владельца, которого можно сверить. Срок — 14 дней:
-- пожелания собирают дольше, чем живёт черновик плана. Истёкшие удаляет сам
-- писатель (lib/planner/trip-groups), отдельного крона нет; участники уходят
-- каскадом.

CREATE TABLE IF NOT EXISTS trip_groups (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  arrival_date    DATE        NOT NULL,
  departure_date  DATE        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
  CONSTRAINT trip_groups_dates_order CHECK (departure_date >= arrival_date)
);

CREATE INDEX IF NOT EXISTS idx_trip_groups_expires ON trip_groups (expires_at);

CREATE TABLE IF NOT EXISTS trip_group_members (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            UUID        NOT NULL REFERENCES trip_groups(id) ON DELETE CASCADE,
  interests           TEXT[]      NOT NULL DEFAULT '{}',
  fitness             VARCHAR(16) NOT NULL CHECK (fitness IN ('beginner', 'moderate', 'active')),
  no_hard_climbs      BOOLEAN     NOT NULL DEFAULT FALSE,
  seasickness         BOOLEAN     NOT NULL DEFAULT FALSE,
  limited_mobility    BOOLEAN     NOT NULL DEFAULT FALSE,
  youngest_child      SMALLINT    CHECK (youngest_child IS NULL OR youngest_child BETWEEN 0 AND 17),
  budget              VARCHAR(16) NOT NULL CHECK (budget IN ('economy', 'comfort', 'premium')),
  pd_consent_at       TIMESTAMPTZ NOT NULL,
  pd_consent_ip       VARCHAR(64),
  pd_consent_source   VARCHAR(32),
  pd_consent_version  VARCHAR(32),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_group_members_group ON trip_group_members (group_id);

COMMENT ON TABLE trip_groups IS
  'Группа для общего плана поездки (#2226): даты, срок 14 дней, без владельца.';
COMMENT ON TABLE trip_group_members IS
  'Пожелания участника группы (#2226): флаги без диагнозов, согласие на ПД обязательно.';

-- План группы ложится тем же черновиком (1182) и открывается на /trip/<id>;
-- поверхность черновика — 'group'. Ограничение пересобирается целиком:
-- удалить, если есть, и поставить заново — повторный прогон даёт то же.
ALTER TABLE trip_plan_drafts DROP CONSTRAINT IF EXISTS trip_plan_drafts_surface_check;
ALTER TABLE trip_plan_drafts ADD CONSTRAINT trip_plan_drafts_surface_check
  CHECK (surface IN ('chat', 'mcp', 'group'));
