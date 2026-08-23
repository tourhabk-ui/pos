/**
 * Миграция 908 — починка, которая не повторяет поломку.
 *
 * `GET /api/operator/tours` селектит `t.excludes` и `t.itinerary`; на проде
 * этих колонок нет, и главный экран кабинета оператора отвечает 42703.
 *
 * Объявила их миграция 114, и она НЕ ЛЕГЛА. Файл идёт одной транзакцией:
 * отказ на любой строке откатывает его целиком, а запись в `_migrations`
 * делается всё равно (задача #58). Улика, что откатился именно весь файл:
 * `operator_tours.includes` на проде ЕСТЬ, а `excludes` и `itinerary` — нет.
 * Значит `includes` пришёл не из 114, а позже, из 690 — и другим типом.
 *
 * НА КАКОЙ СТРОКЕ 114 УМЕРЛА — неизвестно. Напрашивается `tours`, но у этой
 * версии есть прямое опровержение: миграция 042 добавляет в `tours` колонку
 * `tour_image`, и на проде она есть — значит `ALTER TABLE tours` тогда
 * проходил. Догадка отброшена, «не знаю» записано.
 *
 * Отсюда два требования к починке, которые держит сторож: не трогать `tours`
 * (файл, отказ которого не объяснён, повторять целиком нельзя, а род `tours`
 * на этой базе не установлен) и не приводить тип `includes` вслепую (иначе
 * рискуем данными живых туров ради опрятности).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/908_operator_tours_content_repair.sql'), 'utf-8',
);
const ROUTE = readFileSync(
  join(process.cwd(), 'app/api/operator/tours/route.ts'), 'utf-8',
);

/**
 * Тело без комментариев И без строковых литералов.
 *
 * Запреты судятся по КОДУ, а не по объяснению. Убрать только `--` мало:
 * шапка `COMMENT ON COLUMN ... IS '...'` объясняет, на чём умерла 114, и
 * содержит внутри кавычек слова «ALTER TABLE tours». Проверка «файл не
 * трогает tours» ловила эту фразу и требовала выкинуть из документации
 * ровно тот факт, ради которого миграция написана, — то есть подгонку под
 * сторожа вместо починки.
 */
const BODY = SQL
  .replace(/--[^\n]*/g, '')
  .replace(/'(?:[^']|'')*'/g, "''");

describe('миграция 908', () => {
  it('возвращает обе колонки, из-за которых падает кабинет', () => {
    expect(BODY).toMatch(/ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS excludes\s+TEXT\[\]/i);
    expect(BODY).toMatch(/ALTER TABLE operator_tours ADD COLUMN IF NOT EXISTS itinerary\s+JSONB/i);
  });

  it('НЕ трогает tours — род этого отношения не установлен', () => {
    // Не «потому что 114 умерла здесь» (это опровергнуто миграцией 042), а
    // потому что чем `tours` является на этой базе — таблицей или
    // представлением — до сих пор не измерено. Чинить надо то, ради чего
    // писалась миграция, не задевая неизвестного.
    expect(BODY).not.toMatch(/ALTER TABLE\s+tours\b/i);
  });

  it('НЕ приводит тип includes вслепую', () => {
    // Колонка на проде есть, но её тип объявлен дважды (TEXT[] в 114, TEXT в
    // 690). Какой лежит — вопрос к базе. `ALTER ... TYPE ... USING` здесь
    // рисковал бы данными двадцати живых туров ради опрятности.
    expect(BODY).not.toMatch(/ALTER COLUMN\s+includes/i);
    expect(BODY).not.toMatch(/\bTYPE\s+TEXT\[\]/i);
  });

  it('идемпотентна', () => {
    const adds = BODY.match(/ADD COLUMN/gi) ?? [];
    const guarded = BODY.match(/ADD COLUMN IF NOT EXISTS/gi) ?? [];
    expect(guarded.length).toBe(adds.length);
  });

  it('шапка называет замер, а не «похоже, потерялось»', () => {
    expect(SQL).toMatch(/schema-drift/);
    expect(SQL).toMatch(/2026/);
  });
});

describe('чтение includes переживает оба типа', () => {
  it('строка не уезжает в поле, объявленное массивом', () => {
    // Если на проде TEXT, то `row.includes ?? []` отдал бы строку в поле
    // типа string[] — и она отрисовалась бы посимвольно. Пока тип не
    // измерен, читаем оба вида.
    expect(ROUTE).toMatch(/Array\.isArray\(row\.includes\)/);
  });
});
