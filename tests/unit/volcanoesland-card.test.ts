// @vitest-environment node
/**
 * Карточка компании «Край Вулканов» (миграция 1174, #2245).
 *
 * Держит то, что нельзя исправить задним числом: карточка не выдаёт себя за
 * проверенную, не хранит данных людей, не назначает ставку, а файл логотипа,
 * который называет миграция, лежит на диске и читается страницей оператора.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractContacts } from '@/lib/operators/profile-parse';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/1174_volcanoesland_operator_card.sql'), 'utf-8');
const SQL = MIG.replace(/--[^\n]*/g, '');

describe('миграция 1174: карточка без пользователя и без выдуманного', () => {
  it('заводит запись партнёра по slug, и повтор не плодит строк', () => {
    expect(SQL).toMatch(/INSERT INTO partners/);
    expect(SQL).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM partners WHERE slug = 'volcanoesland'\)/);
  });

  it('slug тот, который читает страница /operators/[slug]', () => {
    expect(SQL).toMatch(/'volcanoesland',\s*\n\s*'Край Вулканов'/);
  });

  it('не создаёт пользователя и не ставит чужое согласие на обработку ПД', () => {
    expect(SQL).not.toMatch(/INSERT INTO users/i);
    expect(SQL).not.toMatch(/user_id/);
    expect(SQL).not.toMatch(/pd_consent|consent/i);
  });

  it('не выдаёт карточку за проверенную и не трогает комиссию (§7)', () => {
    expect(SQL).not.toMatch(/is_verified/);
    expect(SQL).not.toMatch(/commission/i);
    expect(SQL).not.toMatch(/verified_at|registry_/);
  });

  it('не выдумывает реквизиты: ИНН, ОГРН и лицензии в записи нет', () => {
    expect(SQL).not.toMatch(/legal_info|inn|ogrn|license/i);
  });

  it('в карточке нет имён людей: только контакты компании', () => {
    expect(SQL).not.toMatch(/admin_name|Эдуард|Эдик/);
  });

  it('логотип ставится только туда, где его нет', () => {
    expect(SQL).toMatch(/logo_image IS NULL OR logo_image = ''/);
  });
});

describe('логотип', () => {
  const path = SQL.match(/'(\/images\/volcanoesland\/[^']+)'/)?.[1];

  it('файл, названный в миграции, лежит в public/ и не пуст', () => {
    expect(path).toBeTruthy();
    const file = join(ROOT, 'public', path as string);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(1000);
  });

  it('это PNG', () => {
    const head = readFileSync(join(ROOT, 'public', path as string)).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe('страница оператора читает контакты карточки', () => {
  // Тот же объект, что пишет миграция в `contacts`.
  const contacts = {
    phone: '+79140291112',
    telegram_contact: '@Volcanoesland',
    email: 'mail@volcanoesland.ru',
    website: 'https://volcanoesland.ru',
    address: 'Петропавловск-Камчатский, пр-т 50 лет Октября, 4/2, офис 19',
  };

  it('значения объекта в миграции те же, что здесь', () => {
    for (const v of Object.values(contacts)) expect(MIG).toContain(v);
  });

  it('телефон, Telegram, почта, сайт и адрес превращаются в строки карточки', () => {
    const items = extractContacts(contacts);
    expect(items.find((c) => c.phone)?.phone).toBe('+79140291112');
    expect(items.map((c) => c.href).filter(Boolean)).toEqual(
      expect.arrayContaining(['https://t.me/Volcanoesland', 'mailto:mail@volcanoesland.ru', 'https://volcanoesland.ru']),
    );
    expect(items.find((c) => c.address)?.address).toContain('50 лет Октября');
  });
});
