/**
 * Оператор без договорённости не попадает на витрину.
 *
 * 05.08 владелец прислал живое объявление оператора «Гамул» и сказал «лид».
 * Правило владельца от 04.08: на витрине только туры, которые партнёры нам
 * предоставили. Поставить чужие туры по объявлению из канала — та самая чужая
 * реклама, которую мы вчера убирали с карточки тура.
 *
 * Отсюда форма: заметка о том, с кем поговорить, живёт в своей таблице без
 * единого внешнего ключа на partners/users. Ни партнёра, ни аккаунта у такого
 * оператора нет, и создавать их ради записи в блокнот нельзя — он ни на что не
 * соглашался. Сторож следит, что заметка не проросла в витрину.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const M = read('migrations/816_partner_prospects.sql');
const API = read('app/api/admin/partner-prospects/route.ts');

/** SQL без строк-комментариев: пояснения не должны считаться кодом. */
const sql = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(name)) out.push(relative('.', rel));
  }
  return out;
}

describe('таблица заметок не притворяется партнёром', () => {
  it('без внешних ключей на partners и users', () => {
    // operator_applications требует partner_id и user_id NOT NULL — это про
    // оператора, который пришёл сам. Здесь оператор ни о чём не просил.
    expect(sql).not.toMatch(/REFERENCES\s+partners/i);
    expect(sql).not.toMatch(/REFERENCES\s+users/i);
  });

  it('не создаёт партнёра и не трогает витрину', () => {
    expect(sql).not.toMatch(/INSERT INTO partners/i);
    expect(sql).not.toMatch(/INSERT INTO operator_tours/i);
    expect(sql).not.toMatch(/UPDATE operator_tours/i);
  });

  it('идемпотентна: повторный прогон не плодит дубли', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS partner_prospects/);
    expect(sql).toMatch(/ON CONFLICT \(LOWER\(name\)\) DO NOTHING/);
  });

  it('статусы ограничены — «в работе» не превращается в свободный текст', () => {
    expect(sql).toMatch(/CHECK \(status IN \('new', 'contacted', 'agreed', 'declined'\)\)/);
  });

  it('записан источник — иначе через месяц непонятно, откуда взялось', () => {
    expect(sql).toMatch(/source/);
    expect(sql).toMatch(/Гамул/);
  });
});

describe('заметка не видна туристу', () => {
  it('таблицу читает только админский маршрут', () => {
    const readers = walk('app').filter((f) => /partner_prospects/.test(read(f)));
    expect(readers.length, 'таблицу вообще никто не читает — эндпоинт потерялся').toBeGreaterThan(0);
    for (const f of readers) {
      expect(f.startsWith('app/api/admin/'), `${f}: читает заметки вне админки`).toBe(true);
    }
  });

  it('маршрут закрыт правами администратора', () => {
    expect(API).toMatch(/requireAdmin\(request\)/);
  });

  it('из заметки нельзя завести партнёра автоматически', () => {
    // Договорённость подтверждает человек — иначе «лид» тихо станет витриной.
    expect(API).not.toMatch(/INSERT INTO partners/i);
    expect(API).not.toMatch(/INSERT INTO operator_tours/i);
  });
});
