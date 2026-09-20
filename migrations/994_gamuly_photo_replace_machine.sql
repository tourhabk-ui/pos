-- 994: снимок каньона на место машинной картинки — и дубль наконец снят.
--
-- ── Третья попытка, и теперь причина названа фактом ───────────────────────
--
-- 988 пропустила переезд молча (накатчик считает duplicate key за «уже
-- существует» и пропускает выражение). 990 переезд не сделала тоже — и это
-- был ПРАВИЛЬНЫЙ отказ по её собственному условию: она соглашалась убрать с
-- целевой записи только ПУСТУЮ строку снимка (ни байтов, ни объекта в
-- хранилище), а там строка оказалась не пуста.
--
-- Чем именно — сказала проба 547, а не догадка: GET /api/images/route/<ark
-- «Крыльев Гамулов»> отвечает 302 в хранилище и отдаёт 358 500 байт
-- image/jpeg, у которого в заголовке стоит «CREATOR: gd-jpeg v1.0 (using IJG
-- JPEG v80)». Это машинная картинка, уехавшая в S3 уборщиком: `image_data`
-- пуст, `s3_key`/`s3_url` заполнены.
--
-- Машинную картинку заменять МОЖНО — это записанное правило платформы, по
-- которому собраны миграции 981/983/984: «машинная заменяется, чужой ручной
-- снимок — нет». Ровно оно здесь и применяется.
--
-- ── Почему содержимое переносится, а не route_id ──────────────────────────
--
-- У `ai_route_images` колонка `route_id` уникальна. Любой UPDATE, двигающий
-- её на занятый ark, получает 23505 — и будет МОЛЧА ПРОПУЩЕН накатчиком
-- (тот же механизм, что съел шаг 988). Значит выражение, способное получить
-- duplicate key, писать нельзя вовсе.
--
-- Поэтому 991 не двигает строку, а переносит СОДЕРЖИМОЕ: поля кадра Андрея
-- Запорожца копируются в строку, уже стоящую на «Крыльях Гамулов», а строка
-- дубля удаляется. Уникальность не задета ни на миг.
--
-- Байты при этом никуда не копируются: у обеих строк снимок живёт объектом
-- в хранилище, переезжает ссылка (`s3_key`/`s3_url`). Объект машинной
-- картинки остаётся в бакете ничей — удалять его отсюда нельзя, у миграции
-- нет и не должно быть доступа к хранилищу; это отдельная уборка.
--
-- ── Порядок прежний: сначала убедиться, потом убирать ─────────────────────
--
-- Строка дубля удаляется только после подтверждённого переноса, а сам дубль
-- скрывается только после того, как на настоящей записи стоит автор кадра.
-- Тот же порядок, что в 980, 988 и 990, и ровно он трижды уберёг снимок от
-- исчезновения на скрытой карточке.
--
-- ПОСЛЕ ВЫКАТА — перезалив пакетов карты (`map-places-build.yml`,
-- upload:true). До него на телефоне остаются два каньона в 780 метрах.
--
-- IDEMPOTENT

BEGIN;

-- ── 0. Если на настоящей записи строки снимка НЕТ — обычный переезд ───────
-- Условие NOT EXISTS обязательно: без него выражение способно получить
-- duplicate key, а такое выражение накатчик пропустит молча.
UPDATE ai_route_images
   SET route_id = (SELECT ark_id FROM places WHERE id::text = 'c03b364f-55c3-4944-8505-3e86058999fa')
 WHERE route_id = 'b3d7eb6c-2ac4-41d9-89fe-52d073c3488d'
   AND author = 'Андрей Запорожец'
   AND (SELECT ark_id FROM places WHERE id::text = 'c03b364f-55c3-4944-8505-3e86058999fa') IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM ai_route_images busy
          WHERE busy.route_id = (SELECT ark_id FROM places WHERE id::text = 'c03b364f-55c3-4944-8505-3e86058999fa')
       );

-- ── 1. Если строка есть и она МАШИННАЯ — её содержимое заменяется ─────────
-- `model NOT IN ('manual-upload', 'wikimedia')` — та же граница, что в
-- 981/983/984: чужой РУЧНОЙ снимок не трогаем ни при каких обстоятельствах.
UPDATE ai_route_images tgt
   SET image_data = src.image_data,
       mime_type  = src.mime_type,
       prompt     = src.prompt,
       model      = src.model,
       width      = src.width,
       height     = src.height,
       author     = src.author,
       s3_key     = src.s3_key,
       s3_url     = src.s3_url,
       created_at = NOW()
  FROM ai_route_images src
 WHERE tgt.route_id = (SELECT ark_id FROM places WHERE id::text = 'c03b364f-55c3-4944-8505-3e86058999fa')
   AND tgt.model NOT IN ('manual-upload', 'wikimedia')
   AND src.route_id = 'b3d7eb6c-2ac4-41d9-89fe-52d073c3488d'
   AND src.author = 'Андрей Запорожец';

-- ── 2. Строка дубля удаляется — только после подтверждённого переноса ─────
DELETE FROM ai_route_images
 WHERE route_id = 'b3d7eb6c-2ac4-41d9-89fe-52d073c3488d'
   AND author = 'Андрей Запорожец'
   AND EXISTS (
         SELECT 1 FROM ai_route_images tgt
          WHERE tgt.route_id = (SELECT ark_id FROM places WHERE id::text = 'c03b364f-55c3-4944-8505-3e86058999fa')
            AND tgt.author = 'Андрей Запорожец'
       );

-- ── 3. Дубль скрывается — только при подтверждённом снимке на настоящей ───
UPDATE places
   SET is_visible     = FALSE,
       merged_into_id = 'c03b364f-55c3-4944-8505-3e86058999fa',
       merged_at      = NOW(),
       updated_at     = NOW()
 WHERE id::text = '002f9a4f-8833-4ee7-8dc4-290b30092cb7'
   AND (is_visible OR merged_into_id IS NULL)
   AND EXISTS (
         SELECT 1 FROM ai_route_images ai
          WHERE ai.route_id = (SELECT ark_id FROM places WHERE id::text = 'c03b364f-55c3-4944-8505-3e86058999fa')
            AND ai.author = 'Андрей Запорожец'
       );

-- ── Исход называется вслух ────────────────────────────────────────────────
DO $$
DECLARE
  v_gam_ark  uuid;
  v_author   text;
  v_model    text;
  v_dup_live boolean;
BEGIN
  SELECT ark_id INTO v_gam_ark FROM places WHERE id::text = 'c03b364f-55c3-4944-8505-3e86058999fa';

  IF v_gam_ark IS NULL THEN
    RAISE WARNING '[994] у «Крыльев Гамулов» нет ark_id — снимку ехать некуда, дубль ОСТАЁТСЯ видимым';
    RETURN;
  END IF;

  SELECT author, model INTO v_author, v_model FROM ai_route_images WHERE route_id = v_gam_ark;
  SELECT is_visible INTO v_dup_live FROM places WHERE id::text = '002f9a4f-8833-4ee7-8dc4-290b30092cb7';

  IF v_author IS DISTINCT FROM 'Андрей Запорожец' THEN
    RAISE WARNING '[994] снимок НЕ встал на «Крылья Гамулов»: там % (model=%); дубль намеренно оставлен видимым',
      COALESCE('автор «' || v_author || '»', 'строки снимка нет'), COALESCE(v_model, '—');
  END IF;

  IF v_dup_live IS TRUE THEN
    RAISE WARNING '[994] дубль «Каньон на Шивелуче» всё ещё видим — перезалив пакетов карты ничего не исправит, пока это так';
  END IF;
END $$;

COMMIT;
