/**
 * Объектив схемы: запрос против baseline и миграций.
 *
 * Повод. 23.08 прочёс выдал 17 находок и его судья объявил «по делу: 0» — в
 * тот же день, когда приём переброса брони не работал вовсе, а подбор туров у
 * планера и у Кузьмича падал в семи местах. Оба дефекта одного рода: КОД
 * СПОРИТ СО СХЕМОЙ. Прочёс читает файлы по одному и со схемой не сверяется —
 * этот класс он не видит принципиально, сколько ни улучшай промпт.
 *
 * Здесь сравниваются два списка. Не эвристика: внешний ключ либо ведёт в ту
 * таблицу, с которой соединяют, либо нет.
 */
import { describe, it, expect } from 'vitest';
import { loadSchemaModel } from '@/lib/agents/evo/schema-model';
import { scanSourceAgainstSchema } from '@/lib/agents/evo/schema-lens';

const schema = loadSchemaModel(process.cwd());

describe('модель схемы собирается из репозитория', () => {
  it('таблицы и внешние ключи прочитаны', () => {
    expect(schema.columns.size).toBeGreaterThan(100);
    expect(schema.foreignKeys.size).toBeGreaterThan(100);
  });

  it('колонки из миграций дописаны к baseline', () => {
    // Без ALTER TABLE … ADD COLUMN проверка «такой колонки нет» врала бы на
    // каждой второй: миграции дописывают колонки годами.
    expect(schema.columns.get('partners')?.has('company_name')).toBe(true);
  });

  it('вьюхи исключены — их состав по запросу не судят', () => {
    // agent_route_knowledge сегодня VIEW поверх places и kamchatka_routes
    // (миграция 663), но одноимённая таблица осталась в baseline.
    expect(schema.views.has('agent_route_knowledge')).toBe(true);
    expect(schema.columns.has('agent_route_knowledge')).toBe(false);
  });

  it('ключ, на котором держится правило оператора, прочитан', () => {
    expect(schema.foreignKeys.get('operator_tours.operator_id')).toMatchObject({
      refTable: 'partners',
      refColumn: 'id',
    });
  });
});

describe('соединение мимо внешнего ключа', () => {
  it('ловит ровно тот дефект, что прожил незамеченным', () => {
    const src = 'const q = `SELECT t.title FROM operator_tours t JOIN users u ON u.id = t.operator_id`;';
    const found = scanSourceAgainstSchema('x.ts', src, schema);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('fk_join_mismatch');
    expect(found[0].message).toContain('partners.id');
  });

  it('верное соединение молчит', () => {
    const src = 'const q = `SELECT t.title FROM operator_tours t JOIN partners p ON p.id = t.operator_id`;';
    expect(scanSourceAgainstSchema('x.ts', src, schema)).toEqual([]);
  });

  it('отставшая схема не выдаётся за дефект кода', () => {
    // reviews.tour_id до сих пор объявлен ссылкой на мёртвую tours, а код
    // давно соединяет с operator_tours — и делает это правильно. Ругать код
    // за то, что он ушёл вперёд схемы, значит наказывать за починку.
    const src = 'const q = `SELECT r.id FROM reviews r JOIN operator_tours t ON t.id = r.tour_id`;';
    const fk = scanSourceAgainstSchema('x.ts', src, schema).filter((m) => m.kind === 'fk_join_mismatch');
    expect(fk).toEqual([]);
  });
});

describe('колонка, которой нет', () => {
  it('ловит обращение к несуществующей колонке', () => {
    const src = 'const q = `SELECT u.company_name FROM users u`;';
    const found = scanSourceAgainstSchema('x.ts', src, schema);
    expect(found.some((m) => m.kind === 'unknown_column' && /company_name/.test(m.message))).toBe(true);
  });

  it('существующая колонка молчит', () => {
    const src = 'const q = `SELECT p.company_name FROM partners p`;';
    expect(scanSourceAgainstSchema('x.ts', src, schema)).toEqual([]);
  });

  it('неизвестная таблица не судится вовсе', () => {
    // Вьюха, CTE, подзапрос, таблица вне реестра — «не знаю» не выдаётся ни
    // за «хорошо», ни за «плохо» (§4.0 CLAUDE.md).
    const src = 'const q = `SELECT x.whatever FROM v_kamchatka_routes_api x`;';
    expect(scanSourceAgainstSchema('x.ts', src, schema)).toEqual([]);
  });

  it('пустая модель схемы отключает объектив, а не красит всё красным', () => {
    const empty = { columns: new Map(), foreignKeys: new Map(), views: new Set<string>() };
    const src = 'const q = `SELECT u.company_name FROM users u`;';
    expect(scanSourceAgainstSchema('x.ts', src, empty)).toEqual([]);
  });
});
