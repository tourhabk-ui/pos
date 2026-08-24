-- Migration 913: guide_schedule.guide_id и guide_earnings.guide_id ведут в partners
--
-- ПОВОД. Объектив схемы (lib/agents/evo/schema-lens.ts) нашёл пять мест, где
-- код соединяет guide_schedule.guide_id и guide_earnings.guide_id с
-- partners.id, а внешний ключ объявлен на users.id. Оба id типа uuid —
-- Постгрес не спорит, совпадений просто не бывает.
--
-- ЧТО ИМЕННО НЕВЕРНО — КЛЮЧ, А НЕ КОД. Три улики, все из репозитория:
--
--   1. Единственный, кто ПИШЕТ в guide_schedule (app/api/guide/schedule/route.ts,
--      строка 221), кладёт в guide_id результат getGuidePartnerId(userId) —
--      то есть partners.id, где category = 'guide'.
--   2. Соседняя таблица про тех же людей объявлена правильно:
--      guide_certifications.guide_id REFERENCES partners(id).
--   3. Все читатели (кабинет гида, кабинет оператора) соединяют с partners.id.
--
-- Гид на платформе — строка в partners (112 аттестованных гидов, CLAUDE.md
-- §4.1), а не в users. Ключ на users.id остался от раннего этапа.
--
-- СЛЕДСТВИЕ. Если ограничение реально стоит в проде, INSERT в расписание
-- падает с нарушением внешнего ключа на КАЖДОЙ попытке: partners.id в
-- users.id не найдётся. То есть расписание гида либо не работало никогда,
-- либо ограничения в живой базе нет вовсе. Отличить одно от другого можно
-- только по данным — поэтому миграция не решает за них, а смотрит.
--
-- ОСТОРОЖНОСТЬ. Правильный ключ добавляется ТОЛЬКО если ни одна строка его не
-- нарушает. Иначе ALTER TABLE провалит всю миграцию, а вместе с ней и деплой:
-- нельзя чинить ключ ценой падения выкладки. В таком случае пишется NOTICE, и
-- решение остаётся за владельцем — данные разбираются отдельно.
--
-- Сверка id идёт через ::text с обеих сторон — этого требует сторож
-- tests/unit/migration-id-type-domain.test.ts: в репозитории уже были
-- миграции, молча сравнивавшие bigint с uuid. Здесь обе стороны uuid, но
-- правило одно для всех, и исключений у него нет.
--
-- Внешние ключи guide_schedule.tour_id и guide_earnings.tour_id ведут в
-- МЁРТВУЮ таблицу tours и здесь НЕ трогаются: чему они должны отвечать
-- сегодня (operator_tours или kamchatka_routes), из схемы не следует.

DO $$
DECLARE
  bad_rows bigint;
BEGIN
  -- ── guide_schedule ────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'guide_schedule') THEN

    ALTER TABLE guide_schedule DROP CONSTRAINT IF EXISTS guide_schedule_guide_id_fkey;

    SELECT COUNT(*) INTO bad_rows
      FROM guide_schedule gs
     WHERE gs.guide_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.id::text = gs.guide_id::text);

    IF bad_rows = 0 THEN
      ALTER TABLE guide_schedule
        ADD CONSTRAINT guide_schedule_guide_id_fkey
        FOREIGN KEY (guide_id) REFERENCES partners(id) ON DELETE CASCADE;
      RAISE NOTICE 'guide_schedule.guide_id: ключ переставлен на partners(id)';
    ELSE
      RAISE NOTICE 'guide_schedule.guide_id: % строк не находят партнёра — ключ НЕ добавлен, разбирать данные', bad_rows;
    END IF;
  END IF;

  -- ── guide_earnings ────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'guide_earnings') THEN

    ALTER TABLE guide_earnings DROP CONSTRAINT IF EXISTS guide_earnings_guide_id_fkey;

    SELECT COUNT(*) INTO bad_rows
      FROM guide_earnings ge
     WHERE ge.guide_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.id::text = ge.guide_id::text);

    IF bad_rows = 0 THEN
      ALTER TABLE guide_earnings
        ADD CONSTRAINT guide_earnings_guide_id_fkey
        FOREIGN KEY (guide_id) REFERENCES partners(id) ON DELETE CASCADE;
      RAISE NOTICE 'guide_earnings.guide_id: ключ переставлен на partners(id)';
    ELSE
      RAISE NOTICE 'guide_earnings.guide_id: % строк не находят партнёра — ключ НЕ добавлен, разбирать данные', bad_rows;
    END IF;
  END IF;
END $$;
