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

describe('объектив судит код, а не прозу вокруг него', () => {
  it('колонка из комментария SQL не считается употреблением', () => {
    // Запрос оператора объясняет сам себя: `-- ta.operator_tour_id, а НЕ
    // ta.tour_id`. Объектив клеймил это предупреждение как обращение к
    // несуществующей колонке — тот же промах, что уже случался у сторожей
    // трижды: суди по коду, не по тексту рядом с ним.
    const src = [
      'const q = `SELECT ta.date FROM tour_availability ta',
      '  -- ta.operator_tour_id, а НЕ ta.tour_id',
      '  WHERE ta.operator_tour_id = $1`;',
    ].join('\n');
    expect(scanSourceAgainstSchema('x.ts', src, schema)).toEqual([]);
  });

  it('блочный комментарий тоже не судится', () => {
    const src = 'const q = `SELECT p.name /* p.email тут нет */ FROM partners p`;';
    expect(scanSourceAgainstSchema('x.ts', src, schema)).toEqual([]);
  });
});

describe('колонка без алиаса', () => {
  it('ловит односоставный запрос — алиасов там не ставят', () => {
    // Агентство трансферов спрашивало несуществующий transfer_operator_id
    // тремя запросами, а в улов попадал только тот, где случился JOIN:
    // остальные два были без алиасов и объективу не видны вовсе.
    const src = 'const q = `SELECT id FROM vehicles WHERE transfer_operator_id = $1`;';
    const found = scanSourceAgainstSchema('x.ts', src, schema);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('transfer_operator_id');
  });

  it('существующая колонка без алиаса молчит', () => {
    const src = 'const q = `SELECT id FROM vehicles WHERE operator_id = $1`;';
    expect(scanSourceAgainstSchema('x.ts', src, schema)).toEqual([]);
  });

  it('при двух таблицах голая колонка не судится: чья она — неизвестно', () => {
    const src = 'const q = `SELECT v.id FROM vehicles v JOIN partners p ON p.id = v.operator_id WHERE transfer_operator_id = $1`;';
    const bare = scanSourceAgainstSchema('x.ts', src, schema)
      .filter((m) => /transfer_operator_id/.test(m.message));
    expect(bare).toEqual([]);
  });
});

describe('мёртвый внешний ключ не судит ничего', () => {
  it('reviews.tour_id → tours не спорит с соединением по маршрутам', () => {
    // Отзывы о МАРШРУТАХ соединяют reviews.tour_id с kamchatka_routes.ark_id
    // осознанно — это записано в шапке запроса модерации. Ключ при этом всё
    // ещё показывает на мёртвую tours. Перечень «законных преемников» тут
    // сразу оказался неполон, поэтому мёртвый ключ молчит целиком.
    const src = 'const q = `SELECT r.id FROM reviews r LEFT JOIN kamchatka_routes kr ON kr.ark_id = r.tour_id`;';
    const fk = scanSourceAgainstSchema('x.ts', src, schema).filter((m) => m.kind === 'fk_join_mismatch');
    expect(fk).toEqual([]);
  });
});
