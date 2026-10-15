/**
 * «Скала Орлиное крыло» скрыта (миграция 1262, владелец 15.10: «4 скрой»).
 *
 * Описание 095 («над морем», 25 м, орланы) источника не имело, а точка стоит
 * больше чем в 15 км от берега; правки координаты взять неоткуда — по правилу
 * §4.1 такую запись прячут, а не двигают наугад. Держится: прячется ровно эта
 * запись (id и имя), ничего не удаляется, путь назад записан.
 * SQL судится по смыслу условий; применение дважды на настоящем PostgreSQL
 * проверено при написании.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(process.cwd(), 'migrations/1262_hide_orlinoe_krylo_rock.sql'), 'utf-8');
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const ID = '0fa4286f-d7e6-4083-814c-9121b3ef3a87';

describe('миграция 1262', () => {
  it('прячет ровно эту запись: по id и имени, только видимую', () => {
    const update = BODY.slice(BODY.indexOf('UPDATE places'), BODY.indexOf('DO $$'));
    expect(update).toMatch(/SET is_visible = false,/);
    expect(update).toContain(`WHERE id::text = '${ID}'`);
    expect(update).toMatch(/AND name = 'Скала Орлиное крыло'/);
    expect(update).toMatch(/AND is_visible = true;/);
  });

  it('не удаляет и не двигает: ни DELETE, ни новой координаты', () => {
    expect(BODY).not.toMatch(/DELETE FROM/);
    expect(BODY).not.toMatch(/\blat\s*=|\blng\s*=/);
  });

  it('путь назад записан', () => {
    expect(SQL).toMatch(/-- UPDATE places SET is_visible = true/);
  });
});
