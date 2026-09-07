-- Migration 932: как турист попадает на тур
--
-- Перепись готовности к чужой витрине (channel-readiness) держит `pickup` в
-- списке недостающего у ВСЕХ восьми живых туров, и до сих пор он считался по
-- пустому `meeting_point`. Владелец 23.08 поправил: пустота там не
-- забывчивость оператора — операторы ЗАБИРАЮТ туристов сами, фиксированной
-- точки сбора у таких туров нет и быть не должно.
--
-- То есть колонка отвечала не на тот вопрос. Покупателю на чужой витрине
-- нужно знать не «где точка сбора», а «как я попаду на тур»: меня заберут,
-- я приду в назначенное место или добираюсь сам. У этих трёх ответов разная
-- цена поездки, разный багаж и разное решение о покупке, а `meeting_point`
-- различал только два состояния — текст и пусто.
--
-- Отсюда `pickup_type` с ТРЕМЯ значениями и NULL как честным четвёртым:
-- NULL значит «у нас не записано», а не «оператор ничего не предлагает»
-- (CLAUDE.md §4.0: у всякого поля должен быть исход «не знаю»).
--
-- `meeting_point` НЕ удаляется и не переименовывается: его читают карточка
-- тура, Кузьмич, структурные данные для поиска и навык Алисы. Здесь он
-- становится частным случаем — подробностями к типу `meeting_point`.

ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS pickup_type VARCHAR(16);
ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS pickup_details TEXT;

-- Значения перечислены в схеме, а не только в коде: иначе завтра появится
-- четвёртое написание того же смысла, и перепись начнёт считать его пробелом.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'operator_tours_pickup_type_check'
  ) THEN
    ALTER TABLE operator_tours ADD CONSTRAINT operator_tours_pickup_type_check
      CHECK (pickup_type IS NULL OR pickup_type IN ('hotel_pickup', 'meeting_point', 'self_drive'));
  END IF;
END $$;

COMMENT ON COLUMN operator_tours.pickup_type IS
  'Как турист попадает на тур: hotel_pickup (заберут) / meeting_point (встреча в точке) / self_drive (добирается сам). NULL — не записано, а НЕ «нет трансфера».';
COMMENT ON COLUMN operator_tours.pickup_details IS
  'Подробности к типу: границы забора, адрес точки, дорога до старта. NULL — не записано.';

-- Перенос того, что уже есть: непустой meeting_point — это ответ «встречаемся
-- в точке», и терять его нельзя. Идемпотентно и только там, где тип ещё не
-- задан: повторный прогон миграции не перепишет более поздний ответ оператора.
UPDATE operator_tours
   SET pickup_type    = 'meeting_point',
       pickup_details = COALESCE(pickup_details, meeting_point)
 WHERE pickup_type IS NULL
   AND meeting_point IS NOT NULL
   AND LENGTH(TRIM(meeting_point)) > 0;

CREATE INDEX IF NOT EXISTS idx_operator_tours_pickup_type
  ON operator_tours (pickup_type) WHERE pickup_type IS NULL;

INSERT INTO _migrations (name)
VALUES ('932_operator_tours_pickup.sql')
ON CONFLICT (name) DO NOTHING;
