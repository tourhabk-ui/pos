-- 1259: Вулкан Вилючинский — главный кадр подписан владельцем платформы
-- Created: 2026-10-15
--
-- ── Почему ────────────────────────────────────────────────────────────────
--
-- Главный кадр карточки «Вулкан Вилючинский» (164f612c) загружен через
-- админку 30.06 (метка снимка v=1782842306 — EXTRACT(EPOCH FROM created_at))
-- и стоял без автора: полей автора в форме загрузки до 14.09 не было вовсе,
-- так что пустая подпись говорила об устройстве формы, а не о снимке.
--
-- Владелец 15.10: «Вилючинский были и мои фото нужно смотреть». Сверка
-- (пробы 927–935): кадр не совпал ни побайтно, ни глазами с присланными
-- владельцем снимками (979 «облачный пояс» и «гамулы», 1036–1039 «вид с
-- Микижи») и ни с одним из 43 файлов Викисклада о Вилючинском. Кадр показан
-- владельцу, ответ: «Мой — подписать».
--
-- Подпись ставится только этой загрузке: та же строка, тот же момент
-- загрузки, автор пуст. Сменится снимок — правка не ляжет на чужой кадр.
-- Лицензия не ставится — снимок собственный (как в 979).

BEGIN;

UPDATE ai_route_images i
   SET author = 'владелец платформы'
  FROM places p
 WHERE p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933'
   AND i.route_id = p.ark_id
   AND i.model = 'manual-upload'
   AND i.author IS NULL
   AND EXTRACT(EPOCH FROM i.created_at)::bigint = 1782842306;

DO $$
DECLARE
  v_author text;
BEGIN
  SELECT i.author INTO v_author
    FROM ai_route_images i JOIN places p ON i.route_id = p.ark_id
   WHERE p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933';
  IF v_author IS DISTINCT FROM 'владелец платформы' THEN
    RAISE WARNING '[1259] главный кадр вулкана Вилючинский не подписан (автор: %) — снимок сменился?', v_author;
  END IF;
END $$;

COMMIT;

-- Rollback:
-- BEGIN;
-- UPDATE ai_route_images i SET author = NULL FROM places p
--  WHERE p.id::text = '164f612c-32da-4f0f-b261-c45c09dc2933' AND i.route_id = p.ark_id
--    AND EXTRACT(EPOCH FROM i.created_at)::bigint = 1782842306;
-- COMMIT;
