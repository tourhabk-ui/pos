// @vitest-environment node
/**
 * Карточка компании «Край Вулканов» (миграция 1174, #2245).
 *
 * Держит то, что нельзя исправить задним числом: карточка скрыта, не выдаёт
 * себя за проверенную и за сверенную с реестром, не хранит данных людей, ставка
 * записана явно по слову владельца, а файл логотипа лежит на диске.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractContacts, extractLegalInfo } from '@/lib/operators/profile-parse';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/1174_volcanoesland_operator_card.sql'), 'utf-8');
const SQL = MIG.replace(/--[^\n]*/g, '');

describe('миграция 1174: исполнитель с реквизитами, без выдуманного', () => {
  it('заводит запись партнёра по slug, и повтор не плодит строк', () => {
    expect(SQL).toMatch(/INSERT INTO partners/);
    expect(SQL).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM partners WHERE slug = 'volcanoesland'\)/);
  });

  it('реквизиты исполнителя записаны так, как читает страница (legal_info)', () => {
    const legal = extractLegalInfo({
      companyName: 'ООО «Туристическая компания Край вулканов»',
      inn: '4101148258',
      ogrn: '1114101007151',
      address: '683024, Петропавловск-Камчатский, пр-т 50 лет Октября, 4/2, офис 19',
    });
    expect(legal).toMatchObject({ inn: '4101148258', ogrn: '1114101007151' });
    for (const v of ['4101148258', '410101001', '1114101007151', 'ООО «Туристическая компания Край вулканов»']) {
      expect(SQL).toContain(v);
    }
  });

  it('карточка скрыта, пока оператор сам не скажет публиковать', () => {
    const tail = SQL.slice(SQL.indexOf('logo_image, commission_current, is_public, created_at'));
    expect(tail).toMatch(/'\/images\/volcanoesland\/logo\.png',\s*\n\s*0,\s*\n\s*FALSE,/);
    expect(SQL).not.toMatch(/is_public\s*=\s*TRUE/i);
  });

  it('реестр: номер записан, а «проверено» не выставлено — сверки не было', () => {
    expect(SQL).toContain("'РТО 018339'");
    expect(SQL).not.toMatch(/registry_status/);
    expect(SQL).not.toMatch(/registry_checked_at|registry_source_url/);
  });

  it('не выдаёт карточку за проверенную платформой', () => {
    expect(SQL).not.toMatch(/is_verified|verified_at/);
  });

  it('комиссия 0 записана явно, по слову владельца; других следов ставки нет', () => {
    expect(SQL).toMatch(/commission_current/);
    expect(SQL).not.toMatch(/commission_rate|agent_commission_rate/);
    expect(MIG).toMatch(/комиссия 0, ставку не согласовывали/);
  });

  it('не создаёт пользователя и не ставит чужое согласие на обработку ПД', () => {
    expect(SQL).not.toMatch(/INSERT INTO users/i);
    expect(SQL).not.toMatch(/user_id/);
    expect(SQL).not.toMatch(/pd_consent|consent/i);
  });

  it('имён директора и учредителей в записи нет — это данные физических лиц', () => {
    expect(SQL).not.toMatch(/Фролов|Новин|Эдуард|Антон|admin_name|director|founder/i);
  });

  it('текст карточки не обещает платежей и называет, с кем договор', () => {
    expect(SQL).toMatch(/Договор о туре заключается с ООО «Туристическая компания Край вулканов»/);
    expect(SQL).toMatch(/Ведар оплату не принимает/);
    expect(SQL).not.toMatch(/оплатить на сайте|онлайн-оплат/i);
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
    phone2: '+79140271112',
    telegram_contact: '@Volcanoesland',
    email: 'mail@volcanoesland.ru',
    website: 'https://volcanoesland.ru',
    address: 'Петропавловск-Камчатский, пр-т 50 лет Октября, 4/2, офис 19',
  };

  it('значения объекта в миграции те же, что здесь', () => {
    for (const v of Object.values(contacts)) expect(MIG).toContain(v);
    // volcanoesland.com — английская версия сайта: хранится, страница её не рисует.
    expect(MIG).toContain('https://volcanoesland.com');
  });

  it('телефон, Telegram, почта, сайт и адрес превращаются в строки карточки', () => {
    const items = extractContacts(contacts);
    expect(items.filter((c) => c.phone).map((c) => c.phone)).toEqual(['+79140291112', '+79140271112']);
    expect(items.map((c) => c.href).filter(Boolean)).toEqual(
      expect.arrayContaining(['https://t.me/Volcanoesland', 'mailto:mail@volcanoesland.ru', 'https://volcanoesland.ru']),
    );
    expect(items.find((c) => c.address)?.address).toContain('50 лет Октября');
  });
});
