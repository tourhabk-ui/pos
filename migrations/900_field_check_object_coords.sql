-- 900: правильная координата объекта в полевой проверке.
--
-- Владелец 21.08: «геолокация точек будет?» — вопрос по делу. Форма 898
-- писала координату ПРОВЕРЯЮЩЕГО (reported_lat/lng): где он стоял в момент
-- проверки. Это не то же самое, что координата объекта: человек может
-- смотреть на скалу с берега, проверять несколько мест подряд с одной
-- стоянки или увидеть, что источник в двухстах метрах в стороне.
--
-- Вердикт «координата не та» без правильной координаты — жалоба без
-- адреса: владелец узнаёт, что запись врёт, и по-прежнему не знает, где
-- объект. Отсюда отдельная пара полей и — обязательно — ПРОИСХОЖДЕНИЕ:
--
--   my_fix   — «я стою на объекте», координата взята с телефона тут же;
--   manual   — введена руками (из другого навигатора, с таблички, с карты);
--   NULL     — координату не давали, и это законное «не знаю».
--
-- Род координаты решает её вес: фикс на объекте с точностью ±5 м и
-- цифры, переписанные из чужого приложения, — разные улики, и склеивать
-- их в одно поле значит потерять разницу навсегда (правило третьего
-- состояния, 19.08).

ALTER TABLE route_field_checks
  ADD COLUMN IF NOT EXISTS object_lat    DECIMAL(9,6),
  ADD COLUMN IF NOT EXISTS object_lng    DECIMAL(9,6),
  ADD COLUMN IF NOT EXISTS object_source VARCHAR(12);

-- Происхождение объявляется явным списком: неизвестный слог означал бы
-- «источник записан», не будучи им.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_field_checks_object_source_chk'
  ) THEN
    ALTER TABLE route_field_checks
      ADD CONSTRAINT route_field_checks_object_source_chk
      CHECK (object_source IS NULL OR object_source IN ('my_fix', 'manual'));
  END IF;
END $$;

-- Половина координаты — не координата: либо пара, либо ничего.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'route_field_checks_object_pair_chk'
  ) THEN
    ALTER TABLE route_field_checks
      ADD CONSTRAINT route_field_checks_object_pair_chk
      CHECK ((object_lat IS NULL) = (object_lng IS NULL));
  END IF;
END $$;
