-- 1325: занятость машины проката по дням — отмечает сам прокатчик.
--
-- Слово владельца 23.10: «в понедельник ко мне приедет Акбар часов в 11 по
-- Камчатке доготовить нужно ддя Акбара кабинет в максе». Календарь — кнопки
-- «Свободна» / «Занята» в его чате, на 30 дней вперёд. Поиск и витрина эту
-- таблицу не читают: отметка не обещает туристу, что машина свободна.
--
-- Строка есть только там, где отметку уже поставили. Дня без строки нет
-- в таблице — это «не отмечено», не «свободна». busy = false — прокатчик
-- сам записал «свободна».
--
-- source: 'operator' — кнопка в чате; 'request' — прокатчик ответил «Беру»
-- на заявку (пишется следующим шагом). lead_id — какая заявка заняла день;
-- NULL у отметки прокатчика. Удаление заявки день не освобождает само:
-- ON DELETE SET NULL, машина остаётся занятой, пока прокатчик не снимет.

BEGIN;

CREATE TABLE IF NOT EXISTS rental_car_busy (
  offer_id   UUID NOT NULL REFERENCES car_rental_offers(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  busy       BOOLEAN NOT NULL,
  source     VARCHAR(16) NOT NULL CHECK (source IN ('operator', 'request')),
  lead_id    UUID REFERENCES leads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (offer_id, day)
);

COMMENT ON TABLE rental_car_busy IS
  'Отметка прокатчика по дню машины (1325): нет строки — не отмечено, не «свободна». Витрина и поиск не читают';
COMMENT ON COLUMN rental_car_busy.busy IS
  'true — занята; false — прокатчик записал «свободна». Отсутствующая строка — не отмечено';
COMMENT ON COLUMN rental_car_busy.source IS
  'operator — кнопка в чате; request — ответ «Беру» на заявку';
COMMENT ON COLUMN rental_car_busy.lead_id IS
  'Заявка, по которой день занят. NULL у отметки прокатчика. Удаление заявки день не освобождает';

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS rental_car_busy;
-- COMMIT;
