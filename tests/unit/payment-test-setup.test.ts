/**
 * Обвязка для проверки оплаты и комиссии на живом проде.
 *
 * Решение владельца 23.08.2026. Подделать оплату нельзя и не нужно: приёмник
 * Точки не верит телу запроса, а спрашивает банк и сверяет сумму. Значит
 * проверка идёт настоящим рублём, и всё, что вокруг него, обязано быть
 * безопасным по построению — а не по внимательности запускающего.
 *
 * Сторож держит три свойства, каждое из которых при небрежности превращает
 * проверку в происшествие: тур не должен попасть в живую витрину, служебная
 * бронь не должна нести персональных данных, а уборка не должна стирать
 * опору доказательства.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/cron/payment-test-setup/route.ts'), 'utf-8',
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('тур не попадает в витрину', () => {
  it('заводится неактивным и неопубликованным', () => {
    // Витрина (/api/tours) фильтрует is_active = true, карточка требует того
    // же. Живой тур за рубль может купить настоящий турист — этого не должно
    // быть возможно даже на десять минут.
    const insert = CODE.slice(CODE.indexOf('INSERT INTO operator_tours'));
    expect(insert.slice(0, insert.indexOf('RETURNING'))).toMatch(/false,\s*false/);
    expect(CODE).toMatch(/tour_visible: false/);
  });

  it('уборка не возвращает тур в витрину', () => {
    const teardown = CODE.slice(CODE.indexOf('UPDATE operator_tours'));
    expect(teardown.slice(0, 200)).toMatch(/is_active = false/);
  });
});

describe('персональных данных нет по построению', () => {
  it('бронь заводится без туриста', () => {
    // tourist_email / tourist_phone / tourist_name в operator_bookings
    // необязательны. Служебной броне турист не нужен, и выдумывать его —
    // значит заводить ПД там, где их можно просто не заводить (152-ФЗ).
    expect(CODE).not.toMatch(/tourist_email|tourist_phone|tourist_name/);
  });

  it('контакт партнёра — пустой объект, а не выдуманный телефон', () => {
    // partners.contact объявлен JSONB NOT NULL. Заполнить его придуманным
    // номером значило бы завести ПД на ровном месте; пустой объект честен:
    // у служебного партнёра контактов нет и быть не должно.
    expect(CODE).toMatch(/'\{\}'::jsonb/);
  });
});

describe('уборка мягкая', () => {
  it('проставляет deleted_at, а не удаляет строки', () => {
    // Строка комиссии ссылается на бронь. Снести бронь значит оставить
    // доказательство висеть в пустоте.
    expect(CODE).toMatch(/UPDATE operator_tours SET deleted_at = NOW\(\)/);
    expect(CODE).toMatch(/UPDATE operator_bookings SET deleted_at = NOW\(\)/);
    expect(CODE).not.toMatch(/DELETE\s+FROM/i);
  });
});

describe('признак сборки виден в любом ответе', () => {
  it('`action` есть и в отказе, не только в успехе', () => {
    // Проба 106 взяла маркером свежести поле, которое появляется лишь при
    // удаче. Роут ответил настоящей ошибкой новой сборки, маркера не
    // нашлось — и проба двенадцать минут ждала выката, которого давно не
    // требовалось, после чего назвала причиной «нет маркера» вместо «роут
    // ответил ошибкой». Признак сборки обязан быть в ЛЮБОМ её ответе.
    expect(CODE).toMatch(/ok: false, action/);
  });
});

describe('тормоза и повторный вызов', () => {
  it('по умолчанию ничего не создаёт', () => {
    expect(CODE).toMatch(/confirm = body\?\.confirm === true/);
    expect(CODE).toMatch(/dry_run: true/);
  });

  it('повторный вызов не плодит дублей', () => {
    // Каждая вставка идёт через WHERE NOT EXISTS по опознавательному имени:
    // второй запуск найдёт своё, а не заведёт второго партнёра и второй тур.
    expect((CODE.match(/WHERE NOT EXISTS/g) ?? []).length).toBe(3);
  });

  it('ставка задана явно, а не оставлена умолчанию', () => {
    // Иначе сухая проверка покажет запасную константу вместо договорной, и
    // будет неясно, читается ли partners.commission_current вообще.
    expect(CODE).toMatch(/COMMISSION_PERCENT\s*=\s*\d+/);
    expect(CODE).toMatch(/commission_current/);
  });

  it('всё в одной транзакции с откатом', () => {
    expect(CODE).toMatch(/BEGIN/);
    expect(CODE).toMatch(/COMMIT/);
    expect(CODE).toMatch(/ROLLBACK/);
    expect(CODE).toMatch(/client\.release\(\)/);
  });

  it('третий исход: не смог — это не «всё готово»', () => {
    expect(CODE).toMatch(/ok: false/);
    expect(CODE).toMatch(/sqlstate/);
    expect(CODE).toMatch(/console\.error/);
  });
});
