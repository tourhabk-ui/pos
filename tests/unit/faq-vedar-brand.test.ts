/**
 * Публичный FAQ говорит от имени Ведара (миграция 1135).
 *
 * Миграция 106 завела тридцать ответов под старым именем — TourHab и
 * tourhab.ru. /faq отдаёт их текстом и разметкой FAQPage, то есть поиск может
 * показать их готовым ответом. Сторож держит связку: КАЖДЫЙ вопрос миграции
 * 106 со старым брендом исправлен поздней миграцией, которая ищет его по
 * вопросу. Новый вопрос со старым брендом, заведённый когда-нибудь ещё, сюда
 * тоже попадёт — список считается из файлов, а не записан руками.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIG_DIR = join(ROOT, 'migrations');
const num = (f: string) => Number(f.match(/^(\d+)_/)?.[1] ?? -1);
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort((a, b) => num(a) - num(b));
const read = (f: string) => readFileSync(join(MIG_DIR, f), 'utf-8');

const OLD_BRAND = /tourhab/i;

/** Пары (вопрос, ответ) из INSERT INTO faqs ... VALUES ('вопрос', 'ответ', ...). */
function insertedFaqs(sql: string): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  const re = /\(\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'/g;
  for (const block of sql.split(/INSERT INTO faqs/).slice(1)) {
    for (const m of block.matchAll(re)) out.push({ question: m[1], answer: m[2] });
  }
  return out;
}

const MIGRATION = read('1135_faq_vedar_brand.sql');
const NEW_ANSWER = MIGRATION.match(/SET question = '[^']*',\s*answer = '([\s\S]*?)',\s*updated_at/)?.[1] ?? '';

describe('FAQ: старое имя платформы не доживает до страницы', () => {
  it('каждый вопрос со старым брендом исправлен поздней миграцией по вопросу', () => {
    const withBrand = files
      .flatMap((f) => insertedFaqs(read(f)).map((r) => ({ ...r, file: f })))
      .filter((r) => OLD_BRAND.test(r.question) || OLD_BRAND.test(r.answer));
    expect(withBrand.length).toBeGreaterThanOrEqual(3);

    for (const row of withBrand) {
      const fixedBy = files
        .filter((f) => num(f) > num(row.file))
        .find((f) => read(f).includes(`WHERE question = '${row.question}'`));
      expect(fixedBy, `не исправлен: «${row.question}» (${row.file})`).toBeTruthy();
    }
  });

  it('новый ответ «Что такое Ведар» без старого бренда и без замороженных чисел', () => {
    expect(NEW_ANSWER.length).toBeGreaterThan(300);
    expect(MIGRATION).toMatch(/SET question = 'Что такое Ведар и чем он может помочь туристу\?'/);
    expect(NEW_ANSWER).not.toMatch(OLD_BRAND);
    expect(NEW_ANSWER).not.toMatch(/\d+\+/); // «260+ объектов» устарело бы так же
    expect(NEW_ANSWER).not.toMatch(/все виды туров/);
  });

  it('про SOS — то же, что ответ миграции 1113: дежурному Ведара, в беде 112', () => {
    expect(NEW_ANSWER).toMatch(/сигнал уходит дежурному Ведара/);
    expect(NEW_ANSWER).toMatch(/В МЧС он сам не передаётся — в беде звоните 112/);
  });

  it('правка ищет строку по старому тексту — ручная правка не затирается', () => {
    expect(MIGRATION).toMatch(/WHERE question = 'Что такое TourHab и чем он может помочь туристу\?'/);
    expect(MIGRATION).toMatch(/AND answer LIKE '%tourhab\.ru\/map%'/);
  });
});
