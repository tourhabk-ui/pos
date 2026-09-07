/**
 * Сторож разбора справочника одним проходом (решение владельца 07.09).
 *
 * ── Что здесь защищается ───────────────────────────────────────────────────
 *
 * Модель, читающая весь корпус, отвечает связным текстом — и именно поэтому
 * ей нельзя верить на слово: связность и правда выглядят одинаково. Ровно на
 * это в репозитории уже есть ответ — `finding-guard` для Growth Scan: находка
 * проверяется детерминированно, а не убедительностью.
 *
 * Здесь тот же приём: находка обязана ссылаться на id ИЗ ВЫДАННЫХ данных,
 * ссылка на маршрут вне корпуса считается выдумкой, а заголовки в отчёте
 * берутся из корпуса по id, а не из ответа модели.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const RUNNER = readFileSync(join(process.cwd(), 'scripts/route-analysis-runner.ts'), 'utf8');
const CORPUS = readFileSync(join(process.cwd(), 'app/api/cron/route-corpus/route.ts'), 'utf8');
const WF = readFileSync(join(process.cwd(), '.github/workflows/route-analysis.yml'), 'utf8');

describe('находка проверяется, а не принимается на слово', () => {
  it('id вне корпуса делает находку выдумкой и она выбрасывается', () => {
    expect(RUNNER).toContain('byId.has(id)');
    expect(RUNNER).toContain('invented');
  });

  it('заголовки в отчёте берутся из корпуса по id, а не из ответа модели', () => {
    // Пересказанное моделью название могло быть переписано на ходу — тогда
    // отчёт называл бы маршрут, которого нет.
    expect(RUNNER).toContain('byId.get(id) as Route');
    expect(RUNNER).toMatch(/for \(const r of f\.routes\)/);
  });

  it('промпт запрещает выдумывать id и требует дословную улику', () => {
    expect(RUNNER).toContain('Не сочиняй id');
    expect(RUNNER).toContain('ДОСЛОВНО');
    // Знание модели о Камчатке — не источник: судить можно только по данным.
    expect(RUNNER).toContain('Не додумывай географию');
  });
});

describe('три исхода, а не два', () => {
  it('пустой корпус — отказ, а не «разобрано чисто»', () => {
    expect(RUNNER).toContain('Корпус пуст');
    expect(RUNNER).toMatch(/это отказ, а не «нарушений нет»/i);
  });

  it('ноль находок краснеет: «чисто» и «не справилась» неразличимы', () => {
    expect(RUNNER).toContain('различить нельзя');
    expect(RUNNER).toMatch(/good\.length === 0[\s\S]{0,400}process\.exit\(1\)/);
  });

  it('молчание модели и отказ HTTP тоже краснеют', () => {
    expect(RUNNER).toContain('Модель не ответила');
    expect(RUNNER).toContain('Ответ без содержимого');
  });
});

describe('разбор ничего не решает сам', () => {
  it('в базу не пишет', () => {
    expect(RUNNER).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(CORPUS).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('сказано вслух, что решает человек', () => {
    // §13: переименование сочиняет смысл — это решение человека, партиями.
    expect(RUNNER).toContain('решает человек');
  });
});

describe('корпус отдаётся целиком и честно', () => {
  it('род связи назван: «рядом» путём не является', () => {
    // §4.1, миграция 874: связь маршрут-место имеет род, и nearby линию не
    // сверяет. Без пометки модель посчитала бы краевой музей путевой точкой.
    expect(CORPUS).toContain('[рядом]');
    expect(CORPUS).toContain('link_kind');
  });

  it('счётчики идут рядом с корпусом — чтобы разбор было с чем сверить', () => {
    expect(CORPUS).toContain('without_geometry');
    expect(CORPUS).toContain('without_waypoints');
  });

  it('отказ запроса — «не смог прочитать», а не «маршрутов нет»', () => {
    expect(CORPUS).toContain("console.error('[route-corpus]");
    expect(CORPUS).toContain('status: 500');
  });

  it('секрет сверяется до запроса к базе', () => {
    const secretAt = CORPUS.indexOf('timingSafeCompare');
    const queryAt = CORPUS.indexOf('pool.query');
    expect(secretAt).toBeGreaterThan(0);
    expect(secretAt).toBeLessThan(queryAt);
  });
});

describe('прогон', () => {
  it('ждёт свою сборку: эндпоинт едет тем же коммитом, что и маркер', () => {
    expect(WF).toContain('run: bash scripts/wait-for-deploy.sh');
  });

  it('модель названа в маркере, а не зашита в workflow', () => {
    expect(WF).toContain('.github/triggers/route-analysis.json');
    expect(WF).toContain("get('model')");
  });
});
