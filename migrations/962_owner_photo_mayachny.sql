-- 13.10 (решение владельца «согласен, перенеси в S3»): байты снимков вынесены в
-- хранилище — ключ migrations/photos/<sha256>.jpg из маркера
-- .github/triggers/migration-photos-to-s3.json (sha256 тех же байтов). Миграция
-- пишет s3_key, image_data пуст; прод переведён по хэшу байтов миграцией 1228.
--
-- 962: Мыс Маячный — свой снимок владельца.
--
-- Владелец прислал 14.09 пять своих кадров мыса. На карточку идёт ОДИН, и не
-- по вкусу: у ai_route_images уникальный индекс по route_id с миграции 107 —
-- одно место, одно карточное фото. Остальные четыре класть некуда, и это
-- записано ниже отдельно, чтобы не выглядело выбором.
--
-- ── Какой из пяти и почему ────────────────────────────────────────────────
--
-- Взят кадр маяка в его ландшафте: горящий огонь, склон, постройки поста.
-- Отвергнуты сознательно, а не отбором «красивее»:
--   • кадр с человеком — узнаваемое лицо на публичной карточке места;
--   • кадр с танковой башней и мачтой поста — действующий пограничный
--     объект; публиковать его решает владелец отдельно, и по умолчанию
--     платформа этого не делает;
--   • крупный план маяка и вид на обрыв — хороши, но карточке нужен один, и
--     общий план объясняет место лучше.
--
-- Обрезка: окно 16:9 полной ширины со смещением 42% сверху. Исходник
-- вертикальный 3000x4000; выше окна только пустое небо, ниже только заросли.
-- Штатный cover/attention на таком кадре ушёл бы в самое контрастное — в
-- светлую полосу неба (урок 958).
--
-- Идемпотентно: ON CONFLICT по route_id, уже лежащий настоящий снимок
-- (wikimedia / manual-upload) не перезаписывается.

INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height, author, s3_key)
SELECT p.ark_id,
       NULL::bytea,
       'image/jpeg',
       'снимок владельца: Мыс Маячный, миграция 962',
       'manual-upload',
       1280,
       720,
       'владелец платформы',
       'migrations/photos/774930a0a9f2ad1e0022160406b229d3be192ab6cb91901e391d31fdf0f0b738.jpg'
  FROM places p
 WHERE (p.id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6'
     OR p.ark_id::text = '3268583a-05e0-4f59-8d2c-a87a69be14a6')
   AND p.ark_id IS NOT NULL
 LIMIT 1
ON CONFLICT (route_id) DO UPDATE
   SET image_data = EXCLUDED.image_data,
       s3_url     = NULL,
       s3_key     = EXCLUDED.s3_key,
       mime_type  = EXCLUDED.mime_type,
       prompt     = EXCLUDED.prompt,
       model      = EXCLUDED.model,
       width      = EXCLUDED.width,
       height     = EXCLUDED.height,
       author     = EXCLUDED.author,
       created_at = NOW()
 WHERE ai_route_images.model NOT IN ('wikimedia', 'manual-upload');
