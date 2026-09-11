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
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/908_operator_tours_content_repair.sql'), 'utf-8',
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

describe('чтение includes: вопрос снят вместе с читателем', () => {
  it('в кабинете не осталось кода, читающего operator_tours.includes', () => {
    // Тип ИЗМЕРЕН 11.09 на настоящей базе: operator_tours.includes — TEXT
    // (information_schema), то есть опасение «строка уедет в поле-массив»
    // было обоснованным. Читателя больше нет: единственным был
    // app/api/operator/tours/route.ts, удалённый в #1803 (500 на
    // несуществующей tour_images, ни одного потребителя). Живой путь
    // кабинета читает массив `included`, а не текстовое `includes`.
    const hits = execSync(
      `grep -rn "row\\.includes\\b" app lib --include=*.ts --include=*.tsx || true`,
      { cwd: process.cwd(), encoding: 'utf-8' },
    ).trim();
    expect(hits, `кто-то снова читает includes:\n${hits}`).toBe('');
  });
});
