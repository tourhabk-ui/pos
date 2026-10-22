-- 1310: тексты карточек мест без записанного автора и источника — в архив
--       (слово владельца 22.10: «всю не правду»).
-- Created: 2026-10-22
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Владелец 22.10: «у нас многие места художественный вымысел слабой ии модели
-- что с этим делать?». Перепись того дня (prod-check 149) по видимым местам:
-- из 286 описаний журнал происхождения (911) знал писателя у 14 — 6 по решению
-- владельца, 5 написала модель, у 3 модель писала последней, а текст потом
-- правили; у 272 журнала не было вовсе. Заметки «Кузьмич о месте» (256) пишет
-- модель, и ни одна не сверена. На вопрос «снять описания без автора и
-- источника и все заметки Кузьмича?» владелец ответил «всю не правду».
--
-- ── Что остаётся ──────────────────────────────────────────────────────────
--
-- Значение поля карточки остаётся, если у него есть хоть одно из трёх:
--   1. источник ГВП — одобренный перевод Global Volcanism Program слово в
--      слово (тот же признак ставит подпись источника на карточке,
--      lib/places/place-detail.ts); только для описания;
--   2. записанный автор не модель — последняя запись журнала 911 сделана не
--      писателем-моделью (owner-decision, fact-correction и т. п.,
--      lib/places/description-by-model.ts); только для описания;
--   3. источник в самой миграции — текст слово в слово тот, что положила
--      миграция с названным источником: Википедия, сайты заповедников и
--      парков, постановления, слово, снимки и полевые данные владельца
--      (реестр ниже — md5 текста, поле и номер миграции).
--
-- Признак 3 судит текст, а не id места. Миграции сужены условием на прежний
-- текст и на проде срабатывали не всегда — 1249 повторяли дважды (1251,
-- 1253); по id под видом справки остался бы прежний текст. Источник ЗАПИСИ
-- места (places.source_name/source_url) уликой не считается: миграция 116
-- приклеила ссылки на Википедию к уже готовым текстам («All locations already
-- have good descriptions»). Реестр пересчитывает из файлов миграций сторож
-- tests/integration/place-unsourced-texts-withdrawn.pg.test.ts — значение
-- складывает PostgreSQL, как при выкате; он же держит, что из миграций с
-- источником не забыт ни один текст.
--
-- ── Что снимается ─────────────────────────────────────────────────────────
--
-- Всё остальное в шести полях карточки: описание, суть (essence), как
-- добраться (access_info), лучший сезон (best_season), по сезонам
-- (seasonal_notes) и заметка Кузьмича — у всех мест, видимых и скрытых
-- (скрытое место открывается обратно вместе с текстом). Суть, доступ и сезон
-- не писал ни один код платформы — только эти миграции и правка в админке, а
-- происхождение остальных значений не записано нигде: та же неизвестность,
-- что у описаний без журнала. Заметки Кузьмича — все: их пишет модель.
-- Единственная не модели — владельца из канала (893); на карточке она стояла
-- под подписью «Заметку написал ИИ-помощник Ведара», то есть неверно, и
-- уходит в архив со своей причиной.
--
-- ── Как — в архив, не в корзину ───────────────────────────────────────────
--
-- Каждое снятое значение — строкой place_text_archive (место, поле, значение,
-- причина, 1310). Вернуть — переписать обратно оттуда. Описание вдобавок
-- ложится в description_withdrawn (1247), если та пуста: по ней карточка
-- говорит «описание убрано»; занятая (дневник 1247, модель 1309) не
-- затирается. Заметка Кузьмича становится пустой строкой, не NULL: писатель
-- заметок берёт только NULL, и пустая строка значит «снято, не писать».
--
-- Описание, оставшееся по признаку 3, получает запись журнала 911: писатель
-- 'migration:<номера>' — миграции, чей текст это слово в слово. Автор
-- становится записанным, и перепись description-writers-census видит его, а
-- не «журнала нет».
--
-- Сколько снято — NOTICE в лог выката; после выката — перепись
-- GET /api/cron/description-writers-census.
--
-- IDEMPOTENT: повтор — no-op: снятое уже пусто, у оставшихся есть журнал,
-- архив уникален по (место, поле, миграция).

BEGIN;

CREATE TABLE IF NOT EXISTS place_text_archive (
  id           BIGSERIAL   PRIMARY KEY,
  place_id     TEXT        NOT NULL,
  field        TEXT        NOT NULL CHECK (field IN
                 ('description', 'essence', 'access_info', 'best_season', 'seasonal_notes', 'kuzmich_review')),
  value        JSONB       NOT NULL,
  reason       TEXT        NOT NULL,
  migration    TEXT        NOT NULL,
  withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (place_id, field, migration)
);

COMMENT ON TABLE place_text_archive IS
  'Тексты, снятые с карточек мест (1310, слово владельца 22.10 «всю не правду»): место, поле, значение, причина. Вернуть — переписать value обратно в places.';

-- Реестр: md5 текстов, которые положили миграции с названным источником.
-- Пересчитывается из файлов миграций сторожем
-- tests/integration/place-unsourced-texts-withdrawn.pg.test.ts.
CREATE TEMP TABLE _sourced_1310 (
  field     TEXT NOT NULL,
  md5       TEXT NOT NULL,
  migration INT  NOT NULL
) ON COMMIT DROP;

INSERT INTO _sourced_1310 (field, md5, migration) VALUES
  ('description', '522094809e5093edf0f9526acc3975a0', 780),
  ('description', '162ad9e6a1133e42b6b0060e7eaddfda', 893),
  ('description', '53117c52d8f1f07c539fba150cb06e61', 925),
  ('description', '5e389a8b6434456130bc0e9345e4dda4', 925),
  ('description', 'b4d3fcd674b0c26600044ab36f786c20', 960),
  ('description', '9f31bf581886a9757d4e09b6445a4774', 966),
  ('description', 'aad790bb181725787a88938701cdd6bf', 967),
  ('description', '5e389a8b6434456130bc0e9345e4dda4', 969),
  ('description', '47c017449231e9caab99f755555e4aad', 987),
  ('description', '2e375bf66af7710e71e34683b3eeb4e4', 988),
  ('description', 'fb7940d323aae41bbca621bf1d619a67', 992),
  ('description', '9cf52569ad53673098e512bcf7533dc8', 997),
  ('description', '91c902959a811371ce8bda64a4e52c09', 1002),
  ('description', '3363317c8939c195c97230c7773a58fd', 1004),
  ('description', 'fd7c7378082f37efb47095b4e4b1c57b', 1034),
  ('description', '01993a72914e3d99116b70eef42b2723', 1038),
  ('description', 'f95eceded752d6cadf2c1b314f0f2000', 1040),
  ('description', 'fd7c7378082f37efb47095b4e4b1c57b', 1042),
  ('description', '8dcf66873aaabe1b35e89c5e30a15d65', 1115),
  ('description', '9ba97c46b31bc8fe3afc3dddc9485518', 1117),
  ('description', 'd46bcedf48084d6811189ea4a573bab8', 1119),
  ('description', 'bebdc5ae88708deb1b6f10866c1511fb', 1149),
  ('description', '24799269d52210d2d5344fe86cd57f92', 1151),
  ('description', '2fe561fb8351979e2db7e58967852925', 1156),
  ('description', '53117c52d8f1f07c539fba150cb06e61', 1157),
  ('description', 'a1696aa1bf32031a0b2d860805d6a42e', 1159),
  ('description', '49318d293f8de0fee04e1ab21a85aae7', 1169),
  ('description', '8416de7e8b0913fe695349d11eef997f', 1240),
  ('essence', '899e4a79778c3779db9f2f9d656045bb', 1240),
  ('access_info', 'ed5d431c6def246f3212824c48bb5b4e', 1240),
  ('best_season', 'eb48834b188104689f3e7db517afabcc', 1240),
  ('description', '25382ee07fef8737bf1c03d63c31b2f6', 1243),
  ('description', '33ed7c61696b42f10917a696a99c7ae6', 1243),
  ('essence', 'c4099fafd78ce1507b61a64c5b0a6921', 1243),
  ('essence', 'f93208d6f9dcdb8d8ff976f82ce2447c', 1243),
  ('access_info', '597800d0e92e3f1f39cf6bf52a32737e', 1243),
  ('access_info', 'b1a4091b32b1fcc9e94d39e3857be855', 1243),
  ('essence', '4be5da4d40daa0a669754a512d091737', 1244),
  ('access_info', 'e7b540d55eb624e4f7290b459c9cbbc0', 1244),
  ('description', '0b8a20d68a235baeb4b8380840a907c9', 1246),
  ('essence', 'ace54e6562d0d18d2634992a5dc75c9b', 1246),
  ('access_info', '08e8f3eaebc904f433bdc311382c1380', 1246),
  ('description', '199711af8272df3b079c2c380933e810', 1248),
  ('description', '8696cdc73dabb70937cc78a2e164b76e', 1248),
  ('description', 'eddb09e59e802d8aad29f081a7e03362', 1248),
  ('essence', '13e014fc0294b758ea667bcf0b1ea930', 1248),
  ('essence', '16de6d732b780bee1b393220f8cf6d25', 1248),
  ('essence', '759cb1e0f5dcd7aecb67dab70282ffb6', 1248),
  ('access_info', '6e7659ff29302035cac194b17bc4ede5', 1248),
  ('description', '387f6ebd89184d94298026e204e44a18', 1249),
  ('description', '6118237c4799d56081c52e8cf644de96', 1249),
  ('description', '9f0293b668b6a1135afce5b194a3f8ac', 1249),
  ('description', 'b8afa8ef5f496ee6107efaa7bbebc8e0', 1249),
  ('description', 'ff156562dfffd834b9f5a67e06d45852', 1249),
  ('essence', '285999bfc265007a1e604fb58e5800bc', 1249),
  ('essence', '5499bc9b6a5a9566cc3f26fa0dcca19b', 1249),
  ('essence', '75146d3a502fb8eccb49a79ec6bbddcd', 1249),
  ('essence', 'ab455c7291c1c33afc67894c57e30415', 1249),
  ('essence', 'c598a98f8a527387c358538683674221', 1249),
  ('description', 'b83d9431a6047aad4a6951dc165bc798', 1250),
  ('description', 'da4388aeaaf82a1ed1800302e5e32ea7', 1250),
  ('essence', '0b0935e7edd72276dbbaea7df684dc3e', 1250),
  ('essence', '87063e64d9a99059c85260d4e0f74659', 1250),
  ('access_info', '914b4c7bd63b94001085925f02122650', 1250),
  ('access_info', 'f6e84150571e9b36659490856550d8b6', 1250),
  ('description', '387f6ebd89184d94298026e204e44a18', 1251),
  ('description', '6118237c4799d56081c52e8cf644de96', 1251),
  ('description', '9f0293b668b6a1135afce5b194a3f8ac', 1251),
  ('description', 'b8afa8ef5f496ee6107efaa7bbebc8e0', 1251),
  ('description', 'ff156562dfffd834b9f5a67e06d45852', 1251),
  ('essence', '285999bfc265007a1e604fb58e5800bc', 1251),
  ('essence', '5499bc9b6a5a9566cc3f26fa0dcca19b', 1251),
  ('essence', '75146d3a502fb8eccb49a79ec6bbddcd', 1251),
  ('essence', 'ab455c7291c1c33afc67894c57e30415', 1251),
  ('essence', 'c598a98f8a527387c358538683674221', 1251),
  ('description', '1615684509d4680a76fd6a4cdfe96419', 1252),
  ('description', '91a6aa2284db30e555482b758f592bfc', 1252),
  ('description', '9bf7fd6d8f8f17a29cf32bc636a023a4', 1252),
  ('description', 'c77572ce37853780e497bcb898cf173f', 1252),
  ('description', 'dcd9fa07954d1e4a492e285d84774b61', 1252),
  ('description', 'eaefd958b693544976da5d2703b1058b', 1252),
  ('essence', '8925e269a4600b0a1c170b9e0712e8c2', 1252),
  ('essence', '9ecd63e091776ed02c7c67dfda5d4190', 1252),
  ('essence', 'a883af47ab05477ce165f44b85b5426d', 1252),
  ('essence', 'adcf1e1f337573723bd3c602ab1809a4', 1252),
  ('essence', 'b998d6e21e1d8ec53139c005fb74d8e1', 1252),
  ('essence', 'e5aad52403913e338b93668fa5b234b0', 1252),
  ('access_info', '19e968fedbfa1ece7a33c8903b9a9f7e', 1252),
  ('access_info', '22d03e7a23e7048437f428fe2b06373d', 1252),
  ('access_info', '2627c420b092e52dbddf8a55d4c90ee9', 1252),
  ('description', '387f6ebd89184d94298026e204e44a18', 1253),
  ('description', '6118237c4799d56081c52e8cf644de96', 1253),
  ('description', '9f0293b668b6a1135afce5b194a3f8ac', 1253),
  ('description', 'b8afa8ef5f496ee6107efaa7bbebc8e0', 1253),
  ('description', 'ff156562dfffd834b9f5a67e06d45852', 1253),
  ('essence', '285999bfc265007a1e604fb58e5800bc', 1253),
  ('essence', '5499bc9b6a5a9566cc3f26fa0dcca19b', 1253),
  ('essence', '75146d3a502fb8eccb49a79ec6bbddcd', 1253),
  ('essence', 'ab455c7291c1c33afc67894c57e30415', 1253),
  ('essence', 'c598a98f8a527387c358538683674221', 1253),
  ('description', '12cebb2f83a10e5446ad7b4d85230a74', 1254),
  ('description', '951db00dfd9021a6d7eef5aab6f41ef2', 1254),
  ('description', 'e70e67fba4eb442fc87ae46ec7da5308', 1254),
  ('essence', '1318f075fbf06e5e4a73d825c16ce645', 1254),
  ('essence', '7a607229f651105e10fc4b60ee3911ac', 1254),
  ('essence', 'b3c61912fdb606d8d8f5417c4d76e54e', 1254),
  ('essence', 'c40bc1ea4b63da864221e4e74c5cbf6d', 1254),
  ('essence', 'e6278f8a4cc8e41ff16bc1abe9685196', 1254),
  ('access_info', '092bb21fd9b43b6e215ff43d24dd8858', 1254),
  ('access_info', '0ad7ebb5418aa21c077c98659743f91b', 1254),
  ('access_info', '720cf0623f0a81b55f00e9f2316a0e50', 1254),
  ('description', '8d63f52769778afc865138252b1281e6', 1255),
  ('essence', '941246eb99df34a860838dcaa4cefa20', 1255),
  ('access_info', 'fa5f543e302c7adc480c6c1cb58aa437', 1255),
  ('description', '55e88524a2428bd70a0d586036e55e5c', 1256),
  ('description', 'a5a4757c8302001c06a06d3b5ea2e33e', 1256),
  ('description', 'e87fdddb9d8b5813c3380453cb37f70a', 1256),
  ('description', 'f1e0d41d586660d7fc2cafc785343547', 1256),
  ('essence', '0502fbea96a5b97e30abfaf50533b7de', 1256),
  ('essence', '28ecfcbe76c66a659125363b0c0a6516', 1256),
  ('essence', '871f4c0eb93271392d8d85fc61e1a983', 1256),
  ('essence', 'eea4643a233edbe16f2e6402511423fc', 1256),
  ('access_info', '4042af6060b685d781009ef169d80985', 1256),
  ('access_info', '502ed9a3c74ad30116a3c97577d68f6f', 1256),
  ('access_info', '9c77137f99d9a43d32ee4541b7a3953a', 1256),
  ('access_info', 'db87fc49ce6a0e8af0fb4286a79211c2', 1256),
  ('description', '3136189823a9b880b38df7481b32ab97', 1257),
  ('description', '40964063bf9aeeaa150061caeea23dff', 1257),
  ('description', '7d9f9c75ec6285d815c4182342721d7e', 1257),
  ('essence', '39027386eb7f47e0a4a1443d151bc1fa', 1257),
  ('essence', 'a7a773a85245c350653d60ad9b1c55a9', 1257),
  ('essence', 'd110bd90d71f9231cd4c1abb7d13d408', 1257),
  ('access_info', '0d978994b3bb677379dd13c23a2dad86', 1257),
  ('access_info', '8fe5f17b08e416d11b165321df54c678', 1257),
  ('description', '30c94f732f2780efd4e0948f8b7bb539', 1264),
  ('description', 'c61f590040b1a9667bacba8e278cdb2d', 1264),
  ('essence', '914e47c276ea3bfdfb1f9dc0647bef33', 1264),
  ('essence', '9c05a8bfcde3baa008e892400a41cda0', 1264),
  ('description', '601964bc5b685dfa6d3dcb3f2e77b870', 1274),
  ('essence', '0e522374381e3e1a09beea6bada7cb06', 1274),
  ('description', '0bfd8c8f020ba13d5c4409c770cbf8b5', 1288),
  ('description', '546de2815df4a9acfcbd00d35fb486b4', 1288),
  ('description', '78ad97e29e706c72c63c06a6ad3b9a52', 1288),
  ('description', 'b8022c5950ba574a71633ba083db1788', 1288),
  ('description', 'c34733cbe003e1c8d8e1dfca9f443629', 1288),
  ('description', 'd55e0ffa156da28be681f45ab5853960', 1288),
  ('description', 'e2eb81e142d2cb4d9a36bc1bf333c2f1', 1288),
  ('essence', '06467782bf000cf44039e6cbc07f63e3', 1288),
  ('essence', '24c4d1ee505b4861fcfd4776ae247c1a', 1288),
  ('essence', '4db7b2e50f8facfe681a54f81d0fdf61', 1288),
  ('essence', 'a50fa5eaa209bb8b2a25143b6765d290', 1288),
  ('essence', 'a78b0c3908075efa2739a5e6adfc784c', 1288),
  ('essence', 'cb42f06a508945abe37578bcf06520ef', 1288),
  ('essence', 'cd7276c5267ce3e76fd7526ff49bc9f5', 1288);

DO $$
DECLARE
  reason_text CONSTANT TEXT :=
    'Ни автор, ни источник не записаны; снято словом владельца 22.10 («всю не правду»), миграция 1310';
  n_journal   INTEGER;
  n_desc      INTEGER;
  n_visible   INTEGER;
  n_fields    INTEGER := 0;
  n_step      INTEGER;
  n_kuzmich   INTEGER;
BEGIN
  -- 1. Описание с источником в миграции (признак 3) — запись журнала, если
  --    писатель-человек ещё не записан. Последняя запись модели при тексте,
  --    равном тексту миграции, — запись о прежнем тексте, не о нынешнем.
  WITH last_write AS (
    SELECT DISTINCT ON (dp.entity_id) dp.entity_id, dp.written_by
      FROM description_provenance dp
     ORDER BY dp.entity_id, dp.written_at DESC, dp.id DESC
  ), src AS (
    SELECT s.md5, string_agg(s.migration::text, ',' ORDER BY s.migration) AS migs
      FROM (SELECT DISTINCT md5, migration FROM _sourced_1310 WHERE field = 'description') s
     GROUP BY s.md5
  )
  INSERT INTO description_provenance
    (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
  SELECT p.ark_id, 'place', p.name, 'migration:' || src.migs, '[]'::jsonb, 0,
         char_length(p.description), NULL
    FROM places p
    JOIN src ON src.md5 = md5(p.description)
    LEFT JOIN last_write lw ON lw.entity_id = p.ark_id
   WHERE p.ark_id IS NOT NULL
     AND (lw.written_by IS NULL
          OR lw.written_by IN ('editor-ai', 'enrich-places-ai', 'enrich-routes-ai')
          OR lw.written_by LIKE 'editor-ai-runner:%');
  GET DIAGNOSTICS n_journal = ROW_COUNT;

  -- 2. Описание без всех трёх признаков — в архив. Журнал уже знает
  --    оставшихся по признаку 3 (шаг 1), так что признак 2 здесь их и держит;
  --    md5 стоит рядом для мест без ark_id, которым журнала не завести.
  WITH last_write AS (
    SELECT DISTINCT ON (dp.entity_id) dp.entity_id, dp.written_by
      FROM description_provenance dp
     ORDER BY dp.entity_id, dp.written_at DESC, dp.id DESC
  ), cand AS (
    SELECT p.id, p.description
      FROM places p
      LEFT JOIN last_write lw ON lw.entity_id = p.ark_id
     WHERE p.description IS NOT NULL AND btrim(p.description) <> ''
       AND NOT EXISTS (
             SELECT 1 FROM place_description_drafts d
              WHERE d.place_id::text = p.id::text AND d.source = 'gvp' AND d.status = 'approved'
                AND d.translated_text = p.description)
       AND (lw.written_by IS NULL
            OR lw.written_by IN ('editor-ai', 'enrich-places-ai', 'enrich-routes-ai')
            OR lw.written_by LIKE 'editor-ai-runner:%')
       AND md5(p.description) NOT IN (SELECT md5 FROM _sourced_1310 WHERE field = 'description')
  ), archived AS (
    INSERT INTO place_text_archive (place_id, field, value, reason, migration)
    SELECT id, 'description', to_jsonb(description), reason_text, '1310' FROM cand
    ON CONFLICT (place_id, field, migration) DO NOTHING
  )
  UPDATE places p
     SET description_withdrawn        = COALESCE(p.description_withdrawn, p.description),
         description_withdrawn_reason = COALESCE(p.description_withdrawn_reason, reason_text),
         description_withdrawn_at     = COALESCE(p.description_withdrawn_at, NOW()),
         description                  = NULL,
         updated_at                   = NOW()
    FROM cand c
   WHERE c.id::text = p.id::text;
  GET DIAGNOSTICS n_desc = ROW_COUNT;

  -- 3. Суть, как добраться, лучший сезон — только признак 3: ни ГВП, ни
  --    журнала у этих полей нет. По сезонам миграции с источником не писали.
  WITH cand AS (
    SELECT id, essence FROM places
     WHERE btrim(COALESCE(essence, '')) <> ''
       AND md5(essence) NOT IN (SELECT md5 FROM _sourced_1310 WHERE field = 'essence')
  ), archived AS (
    INSERT INTO place_text_archive (place_id, field, value, reason, migration)
    SELECT id, 'essence', to_jsonb(essence), reason_text, '1310' FROM cand
    ON CONFLICT (place_id, field, migration) DO NOTHING
  )
  UPDATE places p SET essence = NULL, updated_at = NOW() FROM cand c WHERE c.id::text = p.id::text;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_fields := n_fields + n_step;

  WITH cand AS (
    SELECT id, access_info FROM places
     WHERE btrim(COALESCE(access_info, '')) <> ''
       AND md5(access_info) NOT IN (SELECT md5 FROM _sourced_1310 WHERE field = 'access_info')
  ), archived AS (
    INSERT INTO place_text_archive (place_id, field, value, reason, migration)
    SELECT id, 'access_info', to_jsonb(access_info), reason_text, '1310' FROM cand
    ON CONFLICT (place_id, field, migration) DO NOTHING
  )
  UPDATE places p SET access_info = NULL, updated_at = NOW() FROM cand c WHERE c.id::text = p.id::text;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_fields := n_fields + n_step;

  WITH cand AS (
    SELECT id, best_season FROM places
     WHERE btrim(COALESCE(best_season, '')) <> ''
       AND md5(best_season) NOT IN (SELECT md5 FROM _sourced_1310 WHERE field = 'best_season')
  ), archived AS (
    INSERT INTO place_text_archive (place_id, field, value, reason, migration)
    SELECT id, 'best_season', to_jsonb(best_season), reason_text, '1310' FROM cand
    ON CONFLICT (place_id, field, migration) DO NOTHING
  )
  UPDATE places p SET best_season = NULL, updated_at = NOW() FROM cand c WHERE c.id::text = p.id::text;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_fields := n_fields + n_step;

  WITH cand AS (
    SELECT id, seasonal_notes FROM places WHERE seasonal_notes IS NOT NULL
  ), archived AS (
    INSERT INTO place_text_archive (place_id, field, value, reason, migration)
    SELECT id, 'seasonal_notes', seasonal_notes, reason_text, '1310' FROM cand
    ON CONFLICT (place_id, field, migration) DO NOTHING
  )
  UPDATE places p SET seasonal_notes = NULL, updated_at = NOW() FROM cand c WHERE c.id::text = p.id::text;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_fields := n_fields + n_step;

  -- 4. Заметки Кузьмича — все: пустая строка, не NULL (писатель берёт NULL).
  WITH cand AS (
    SELECT id, kuzmich_review FROM places WHERE btrim(COALESCE(kuzmich_review, '')) <> ''
  ), archived AS (
    INSERT INTO place_text_archive (place_id, field, value, reason, migration)
    SELECT id, 'kuzmich_review', to_jsonb(kuzmich_review),
           CASE WHEN md5(kuzmich_review) = 'dc68e355978ff18e87eac4bdf7c6e684'
                THEN 'Заметка владельца из канала (миграция 893) стояла под подписью «Заметку написал ИИ-помощник Ведара» — неверной; снята вместе с заметками модели словом владельца 22.10 («всю не правду»), миграция 1310'
                ELSE 'Заметку «Кузьмич о месте» писала модель, сверки с источником не было; снято словом владельца 22.10 («всю не правду»), миграция 1310'
           END,
           '1310'
      FROM cand
    ON CONFLICT (place_id, field, migration) DO NOTHING
  )
  UPDATE places p SET kuzmich_review = '', updated_at = NOW() FROM cand c WHERE c.id::text = p.id::text;
  GET DIAGNOSTICS n_kuzmich = ROW_COUNT;

  SELECT COUNT(*) INTO n_visible
    FROM place_text_archive a JOIN places p ON p.id::text = a.place_id::text
   WHERE a.migration = '1310' AND a.field = 'description'
     AND p.is_visible = TRUE AND p.merged_into_id IS NULL;

  RAISE NOTICE '1310: журнал источника записан описаниям: %; описаний снято: % (видимых мест: %); значений сути, доступа и сезона снято: %; заметок Кузьмича снято: %',
    n_journal, n_desc, n_visible, n_fields, n_kuzmich;
END $$;

COMMIT;
