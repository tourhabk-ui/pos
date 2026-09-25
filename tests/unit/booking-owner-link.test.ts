/**
 * Сторож: бронь находится в личном кабинете того, кто её оставил.
 *
 * Слово владельца 14.09: «бронь в любом случае должна сохраняться в личном
 * кабинете». Проверка показала, что это было не пожелание, а описание дефекта.
 *
 * ── Что нашлось ────────────────────────────────────────────────────────────
 *
 * Платформа привязывает бронь к человеку ДВУМЯ способами, и читатели
 * разделились ровно пополам: личный кабинет туриста, отмена брони и админка
 * ищут по `metadata->>'user_id'`, а экспорт ПД и вся операторская сторона — по
 * колонке `user_id`.
 *
 * `app/api/bookings/tour` пишет ОБЕ, причём явно, с комментарием «user_id и в
 * колонку (не только в metadata)» и ссылкой на `/api/hub/bookings/create` как
 * на образец. Но в самом create этого больше нет: бронь заводит общий
 * `reserveBooking`, и при переезде туда переехала только колонка.
 *
 * Итог: бронь, оставленная вошедшим человеком через форму заявки или через
 * Кузьмича, у оператора видна, а в личном кабинете самого туриста — нет, и
 * отменить её оттуда нельзя.
 *
 * Это тот же класс, что уже описан в шапке `lib/bookings/reserve.ts` — «бронь,
 * которой для платформы не существует». Тогда расходились две копии кода;
 * теперь разошлись две записи одного факта внутри одной строки.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Не «обе записи существуют» — это можно было бы удовлетворить, ничего не
 * починив. Держатся три связки: запись обеих привязок при создании, реестр
 * читателей (замороженный, убывающий) и бэкфилл уже созданных броней.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/* ─── 1. Создание: обе привязки ────────────────────────────────────────────── */

describe('бронь заводится с обеими привязками к человеку', () => {
  const reserve = read('lib/bookings/reserve.ts');

  it('user_id уходит и в колонку, и в metadata', () => {
    // Голая передача metadata — ровно тот код, что был до 14.09: канал
    // записывался, а владелец брони терялся для половины платформы.
    expect(reserve).not.toMatch(/input\.metadata \? JSON\.stringify\(input\.metadata\) : null/);
    expect(reserve).toMatch(/user_id: input\.userId/);
    // Колонка тоже на месте — «починка», снявшая её, была бы обменом одной
    // половины читателей на другую.
    expect(reserve).toMatch(/input\.userId \?\? null/);
  });

  it('метка канала не подменяется привязкой, а сливается с ней', () => {
    // У Кузьмича в metadata лежит tg_chat_id; затереть его, дописывая
    // user_id, значило бы починить ЛК ценой потери канала.
    expect(reserve).toMatch(/\.\.\.\(input\.metadata \?\? \{\}\)/);
  });

  it('гостевая бронь не получает выдуманного владельца', () => {
    // Без userId ключа user_id в metadata быть не должно: пустая строка или
    // «null» строкой найдутся запросом ЛК и приведут к чужой брони.
    expect(reserve).toMatch(/input\.userId \? \{ user_id: input\.userId \} : \{\}/);
  });
});

/* ─── 2. Реестр читателей ──────────────────────────────────────────────────── */

/**
 * Кто по какой привязке ищет. Реестр заморожен и может ТОЛЬКО СОКРАЩАТЬСЯ:
 * пока в нём две колонки, писать обязательно обеим. Опустеет одна сторона —
 * дубль можно снимать, и тест об этом скажет.
 */
const READS_METADATA = [
  'app/api/bookings/route.ts',              // личный кабинет туриста
  'app/api/bookings/[id]/cancel/route.ts',  // отмена брони туристом
  'app/api/admin/bookings/route.ts',
  'app/api/admin/users/route.ts',
  'app/api/admin/users/[id]/route.ts',
  'app/api/admin/dashboard/route.ts',
];

const READS_COLUMN = [
  'app/api/user/export/route.ts',           // выгрузка ПД по требованию человека
  'app/api/operator/stats/route.ts',
  'app/api/operator/bookings/route.ts',
  'app/api/operator/clients/[id]/route.ts',
];

describe('реестр читателей привязки', () => {
  it('читатели metadata действительно читают metadata', () => {
    for (const f of READS_METADATA) {
      expect(read(f), `${f} больше не ищет по metadata — снять из реестра`)
        .toMatch(/metadata->>'user_id'/);
    }
  });

  it('читатели колонки действительно читают колонку', () => {
    for (const f of READS_COLUMN) {
      expect(read(f), `${f} больше не ищет по колонке — снять из реестра`)
        .toMatch(/\b(b|ob)\.user_id\b|WHERE user_id/);
    }
  });

  it('новый читатель не заводится молча', () => {
    // Обход всех роутов: кто ищет бронь по владельцу и не внесён — красный.
    // Иначе реестр устаревает ровно тогда, когда становится нужен.
    const known = new Set([...READS_METADATA, ...READS_COLUMN,
      // Пишут, а не ищут: у них своя проверка выше и в миграции.
      'app/api/bookings/tour/route.ts',
    ]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (e.name !== 'route.ts') continue;
        const src = readFileSync(join(ROOT, rel), 'utf-8');
        if (!/operator_bookings/.test(src)) continue;
        if (!/metadata->>'user_id'/.test(src)) continue;
        if (!known.has(rel)) found.push(rel);
      }
    };
    walk('app/api');
    expect(found, `ищет бронь по владельцу и не внесён в реестр: ${found.join(', ')}`).toEqual([]);
  });

  it('пока обе стороны непусты — дубль обязателен', () => {
    // Смысл реестра: он объясняет, ПОЧЕМУ писать надо дважды. Опустеет одна
    // сторона — условие отпадает, и это будет видно здесь, а не в чьей-то
    // памяти.
    expect(READS_METADATA.length).toBeGreaterThan(0);
    expect(READS_COLUMN.length).toBeGreaterThan(0);
  });
});

/* ─── 3. Уже созданные брони ───────────────────────────────────────────────── */

describe('бэкфилл существующих броней', () => {
  const mig = read('migrations/970_booking_owner_link.sql');
  /**
   * Только исполняемый SQL. Комментарии в этой миграции НАЗЫВАЮТ неверную
   * форму как пример ловушки — проверять их наравне с кодом значило бы
   * краснеть на собственном объяснении.
   */
  const sql = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('выравнивает в ОБЕ стороны', () => {
    // Односторонний бэкфилл чинил бы половину читателей, а вторая продолжала
    // бы терять те же самые брони.
    expect(sql).toMatch(/SET metadata[\s\S]{0,200}user_id/);
    expect(sql).toMatch(/SET user_id = u\.id/);
  });

  it('идемпотентна: трогает только пустое', () => {
    expect(sql).toMatch(/metadata->>'user_id' IS NULL/);
    expect(sql).toMatch(/b\.user_id IS NULL/);
  });

  it('расхождение не чинится автоматом', () => {
    // В колонке один человек, в metadata другой — это не пустота, и какая из
    // записей верна, миграция знать не может. Такую строку не трогаем вовсе.
    expect(sql).not.toMatch(/SET user_id[\s\S]{0,120}b\.user_id IS NOT NULL/);
    expect(mig).toContain('не пустота');
  });

  it('приведения к uuid нет вовсе — значение берётся ИЗ users', () => {
    /**
     * Две болезни первой редакции, и обе лечит одно решение.
     *
     * 1. `SET user_id = (metadata->>'user_id')::uuid` с regex-фильтром в том же
     *    WHERE: порядок вычисления условий НЕ ГАРАНТИРОВАН, планировщик вправе
     *    выполнить приведение раньше фильтра, и первая кривая запись уронила бы
     *    миграцию целиком. Это же запрещает migration-id-type-domain.
     * 2. `metadata` внутри коррелированного подзапроса разрешалась в
     *    `users.metadata` — у users есть своя такая колонка. Ошибки нет,
     *    условие всегда ложно, миграция тихо не делает ничего.
     *
     * Взяв uuid ИЗ users через JOIN, снимаем обе: приводить нечего, имена
     * разведены алиасами, а мусор просто не совпадёт ни с одним настоящим id —
     * regex стал не нужен.
     */
    expect(sql, 'приведение к uuid вернулось').not.toMatch(/::\s*uuid/i);
    expect(sql).toMatch(/FROM users u/);
    expect(sql).toMatch(/u\.id::text = b\.metadata->>'user_id'/);
  });
});
