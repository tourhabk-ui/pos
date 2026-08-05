-- Migration 828: снасти входят в стоимость — заход после починки типов
--
-- Источник: Ярослав («Камчатка Семейный Рафтинг»), через владельца 05.08:
-- «я никакие снасти не даю в аренду, я их просто бесплатно даю». Отдельно
-- просил не указывать количество — сколько нужно, столько и даёт, это не
-- позиция прайса.
--
-- Содержимое повторяет 824. 824 упала (`COALESCE types jsonb and text[]
-- cannot be matched`), потому что упала 823 перед ней: колонки остались jsonb.
-- Теперь тип чинит 827 — отдельным файлом, потому что раннер выполняет файл
-- одной транзакцией, и падение состава не должно откатывать смену типа.
--
-- Правим ВСЕ активные туры оператора, без выбора «канонического» подзапросом:
-- ровно такой выбор через `ORDER BY ... LIMIT 1` промахивался молча в 819.
-- Ограничение по оператору обязательно — у «Камчатской Рыбалки» в «не входит»
-- честно стоит аренда снастей, и это ИХ условия.
--
-- Массивы не переписываем целиком: убираем только строки про аренду и прокат
-- снастей, порядок остальных сохраняем. Остального состава я не видел и
-- трогать его не вправе. Идемпотентна.

UPDATE operator_tours ot
   SET not_included = COALESCE((
         SELECT array_agg(x ORDER BY ord)
           FROM unnest(COALESCE(ot.not_included, ARRAY[]::text[])) WITH ORDINALITY AS t(x, ord)
          WHERE x !~* '(аренд|прокат)'
             OR x !~* '(снаст|удоч|спиннинг)'
       ), ARRAY[]::text[]),
       included = CASE
         WHEN NOT EXISTS (
           SELECT 1
             FROM unnest(COALESCE(ot.included, ARRAY[]::text[])) AS y
            WHERE y ILIKE '%снаст%' OR y ILIKE '%удоч%'
         )
         THEN COALESCE(ot.included, ARRAY[]::text[]) || 'Рыболовные снасти'::text
         ELSE ot.included
       END,
       updated_at = NOW()
  FROM partners p
 WHERE p.id = ot.operator_id
   AND p.slug = 'kamchatka-rafting'
   AND ot.deleted_at IS NULL
   AND (
     EXISTS (
       SELECT 1
         FROM unnest(COALESCE(ot.not_included, ARRAY[]::text[])) AS x
        WHERE x ~* '(аренд|прокат)' AND x ~* '(снаст|удоч|спиннинг)'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM unnest(COALESCE(ot.included, ARRAY[]::text[])) AS y
        WHERE y ILIKE '%снаст%' OR y ILIKE '%удоч%'
     )
   );
