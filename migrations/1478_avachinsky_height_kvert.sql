-- 1478: высота Авачинского вулкана — 2751 м по каталогу KVERT (поверх 1473).
-- Created: 2026-11-21
--
-- Решение владельца 21.11: высота Авачинского везде — 2751 м, как в каталоге
-- активных вулканов KVERT (Институт вулканологии и сейсмологии ДВО РАН,
-- геопортал ИВиС: geoportal.kscnet.ru/volcanoes/volc?name=Avachinsky —
-- «Absolute Elevation: 2751 m»). 2741 м — из Википедии («Авачинская Сопка»).
-- Миграция 1473 привела описания к 2741 м («Его высота — 2741 метр»); эта
-- миграция возвращает 2751 м.
--
-- Там, где текст ссылается на Википедию (статья vulkany-kamchatki, источник
-- [6]), оставлена оговорка — так же, как у Толбачика в 1475:
-- «2751 м (KVERT ИВиС ДВО РАН; в Википедии — 2741 м …)».
--
-- Только точечные replace по фразам, где рядом названо имя вулкана: «2741»
-- без Авачинского (у других объектов) не трогается. Повтор ничего не меняет;
-- updated_at двигается только у изменённых строк.

CREATE OR REPLACE FUNCTION pg_temp.ava_2751(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(t,
    'Авачинский (2741 м)',            'Авачинский (2751 м)'),
    'Авачинский (2 741 м)',           'Авачинский (2751 м)'),
    'Авачинский вулкан (2741 м)',     'Авачинский вулкан (2751 м)'),
    'Авачинский вулкан (2 741 м)',    'Авачинский вулкан (2751 м)'),
    'Авачинский вулкан — 2 741 м',    'Авачинский вулкан — 2751 м'),
    'Авачинского вулкана (2741 м)',   'Авачинского вулкана (2751 м)'),
    'Авачинского (2741 м)',           'Авачинского (2751 м)'),
    'Авачинским (2741 м)',            'Авачинским (2751 м)'),
    'Его высота — 2741 метр',         'Его высота — 2751 метр'),
    'вулканов Камчатки, высотой 2741 метр', 'вулканов Камчатки, высотой 2751 метр'),
    '| 2741 м (по другим данным 2717 м) [6] |',
    '| 2751 м (KVERT ИВиС ДВО РАН; в Википедии — 2741 м, по другим данным 2717 м) [6] |')
$$;

-- Описания маршрутов, точек и мест (089, 094, 098, 101, 104, 113, 153→1473)
UPDATE kamchatka_routes SET description = pg_temp.ava_2751(description), updated_at = NOW()
 WHERE description LIKE '%Авачинск%' AND description IS DISTINCT FROM pg_temp.ava_2751(description);
UPDATE kamchatka_routes SET metadata = metadata || '{"height_m":2751}'::jsonb, updated_at = NOW()
 WHERE metadata->>'height_m' = '2741' AND (title ILIKE '%Авач%' OR description LIKE '%Авачинск%');
UPDATE agent_route_knowledge SET description = pg_temp.ava_2751(description), updated_at = NOW()
 WHERE description LIKE '%Авачинск%' AND description IS DISTINCT FROM pg_temp.ava_2751(description);
UPDATE places SET description = pg_temp.ava_2751(description), updated_at = NOW()
 WHERE description LIKE '%Авачинск%' AND description IS DISTINCT FROM pg_temp.ava_2751(description);

-- FAQ (106) и знания Кузьмича (141)
UPDATE faqs SET answer = pg_temp.ava_2751(answer), updated_at = NOW()
 WHERE answer LIKE '%Авачинск%' AND answer IS DISTINCT FROM pg_temp.ava_2751(answer);
UPDATE agent_knowledge SET compiled_truth = pg_temp.ava_2751(compiled_truth), updated_at = NOW()
 WHERE compiled_truth LIKE '%Авачинск%' AND compiled_truth IS DISTINCT FROM pg_temp.ava_2751(compiled_truth);

-- Туры (1176, 1217, 1339, 1342): короткое и полное описание, программа
UPDATE operator_tours
   SET short_description = pg_temp.ava_2751(short_description),
       description       = pg_temp.ava_2751(description),
       program           = pg_temp.ava_2751(program::text)::jsonb,
       updated_at        = NOW()
 WHERE (short_description LIKE '%Авачинск%' OR description LIKE '%Авачинск%' OR program::text LIKE '%Авачинск%')
   AND (short_description IS DISTINCT FROM pg_temp.ava_2751(short_description)
        OR description IS DISTINCT FROM pg_temp.ava_2751(description)
        OR program::text IS DISTINCT FROM pg_temp.ava_2751(program::text));

-- Статьи (1471): таблица в vulkany-kamchatki ссылается на Википедию [6] —
-- с оговоркой; остальные фразы — как выше.
UPDATE articles SET body = pg_temp.ava_2751(body), updated_at = NOW()
 WHERE body LIKE '%Авачинск%' AND body IS DISTINCT FROM pg_temp.ava_2751(body);
