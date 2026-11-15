-- 1443: возраст каждого ребёнка участника группы.
--
-- Слово владельца 15.11 «да, спрашивай число детей у каждого» — на находку
-- разбора планера 14.11 (движок-12): анкета группы спрашивала только возраст
-- младшего ребёнка участника, и план группы из трёх участников с детьми 6, 9
-- и 12 лет считал одного ребёнка на всех — четыре человека вместо шести.
-- Отсюда заниженные места, цена на группу и минимум группы.
--
-- Анкета теперь спрашивает, сколько детей едет с участником, и возраст
-- каждого. Колонка — массив возрастов; NULL — участник отметился до этой
-- миграции, записан только младший (youngest_child), и план так и говорит.
-- youngest_child пишется по-прежнему — младший из массива.
--
-- Идемпотентна: колонка и ограничение ставятся, только если их нет.

ALTER TABLE trip_group_members ADD COLUMN IF NOT EXISTS children_ages SMALLINT[];

ALTER TABLE trip_group_members DROP CONSTRAINT IF EXISTS trip_group_members_children_ages_check;
ALTER TABLE trip_group_members ADD CONSTRAINT trip_group_members_children_ages_check CHECK (
  children_ages IS NULL OR (
    cardinality(children_ages) <= 10
    -- NULL внутри массива проверку «0 <= ALL» прошёл бы (сравнение даёт NULL,
    -- а CHECK считает NULL выполненным) — запрещён отдельно (ревью #3384).
    AND array_position(children_ages, NULL) IS NULL
    AND 0 <= ALL (children_ages)
    AND 17 >= ALL (children_ages)
  )
);

COMMENT ON COLUMN trip_group_members.children_ages IS
  'Возраст каждого ребёнка, который едет с участником (1443); пустой массив — детей нет; NULL — записан только младший (youngest_child).';
