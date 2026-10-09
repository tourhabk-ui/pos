-- 1190: автор трёх вечерних кадров «Шатуна» — Сладченко Виктор Леонидович.
--
-- Владелец 09.10 ответил на прямой вопрос («кто снимал вечерние кадры с
-- вахтовкой, он же Сладченко или нет?»): «да, Сладченко». Раньше (1186) автор
-- был назван только у восьми снимков дикой природы (shatun-16..23), а эти три
-- шли под подписью перевозчика: приписывать авторство по догадке было нельзя
-- (§4.0), и до слова владельца они оставались «Шатун».
--
-- Это shatun-01 (вечерний берег с надписью на борту, герой карточки),
-- shatun-02 (закат и открытая дверь) и shatun-03 (вечер с огнями) — те три
-- «атмосферных» кадра, что владелец прислал вторым сообщением и сам назвал
-- атмосферными. Прочие кадры вахтовки и салона (shatun-04..15) по-прежнему под
-- подписью «Шатун»: про них владелец не говорил.
--
-- Карта дополняется, а не заменяется: подпись ставится только там, где ключа
-- ещё нет, — чужую правку администратора из кабинета не затираем.
--
-- IDEMPOTENT

BEGIN;

UPDATE partners p
   SET gallery_credits = p.gallery_credits || jsonb_strip_nulls(jsonb_build_object(
         '/images/shatun/shatun-01.jpg',
           CASE WHEN p.gallery_credits ? '/images/shatun/shatun-01.jpg' THEN NULL ELSE 'Сладченко Виктор Леонидович' END,
         '/images/shatun/shatun-02.jpg',
           CASE WHEN p.gallery_credits ? '/images/shatun/shatun-02.jpg' THEN NULL ELSE 'Сладченко Виктор Леонидович' END,
         '/images/shatun/shatun-03.jpg',
           CASE WHEN p.gallery_credits ? '/images/shatun/shatun-03.jpg' THEN NULL ELSE 'Сладченко Виктор Леонидович' END
       )),
       updated_at = NOW()
 WHERE p.slug = 'shatun';

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM partners p, jsonb_each_text(p.gallery_credits) AS c(k, v)
   WHERE p.slug = 'shatun' AND c.v = 'Сладченко Виктор Леонидович';
  IF v_n <> 11 THEN
    RAISE WARNING '[1190] «Шатун»: кадров с автором Сладченко % (нужно 11 = 8 + 3); карта могла быть правлена из админки', v_n;
  END IF;
END $$;

COMMIT;
