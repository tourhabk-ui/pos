/**
 * У участника группы нет колонок паспорта (#3388 п.1, слово владельца 15.11
 * «3388», миграция 1445).
 *
 * booking_group_members держала номер паспорта открытым текстом и его
 * шифрованную копию. Код их не писал и не читал — только обнулял при
 * удалении аккаунта. Колонка ПД без производителя — место, куда паспорт
 * однажды ляжет без срока хранения, шифрования и согласия на эту цель.
 *
 * Схема — та же, что строит деплой: baseline плюс миграции после границы
 * снимка (tests/helpers/pd-census). Что после миграции удаление аккаунта
 * работает на настоящей базе, держит сцена удаления в
 * tests/integration/tourist-cabinet.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { schemaFromRepo } from '../helpers/pd-census';

describe('участник группы: паспорта в схеме нет', () => {
  it('колонок паспорта нет, прочие колонки таблицы на месте', () => {
    const cols = schemaFromRepo().columns.get('booking_group_members');
    // Таблица видна разбору: иначе «колонки нет» было бы правдой по ошибке.
    expect(cols?.has('booking_id')).toBe(true);
    expect(cols?.has('full_name')).toBe(true);
    expect(cols?.has('passport_number')).toBe(false);
    expect(cols?.has('passport_encrypted')).toBe(false);
  });
});
