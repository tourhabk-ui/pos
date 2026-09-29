/**
 * Ответ FAQ про SOS называет только проверенные номера (миграция 1113).
 *
 * Миграция 106 записала в публичный FAQ «КМПСС (горноспасатели): +7 (914)
 * 782-22-22» — это телефон оператора «Камчатская рыбалка» (миграции 840/841,
 * слова владельца), и «МЧС: 8 (4152) 41-00-01», которого нет среди
 * проверенных владельцем номеров. /faq отдаёт ответ и разметкой FAQPage.
 *
 * Единственный источник номеров — lib/safety/emergency-numbers.ts: сторож
 * вынимает из нового ответа ВСЕ номера и требует, чтобы каждый там был.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EMERGENCY_NUMBERS, VERIFIED_REGIONAL } from '@/lib/safety/emergency-numbers';

const ROOT = process.cwd();
const MIGRATION = readFileSync(join(ROOT, 'migrations/1113_faq_sos_answer_verified_numbers.sql'), 'utf-8');
const ANSWER = MIGRATION.match(/SET answer = '([\s\S]*?)',\s*updated_at/)?.[1] ?? '';

const digits = (s: string) => s.replace(/\D/g, '');
/** Все телефоны в тексте: +7 (4152) 30-10-89, 8 (4152) 41-00-01 и короткие 112/101. */
function phonesIn(text: string): string[] {
  const long = text.match(/(?:\+7|8)\s*\(\d{3,4}\)\s*[\d-]{5,9}/g) ?? [];
  const bare = text.replace(/(?:\+7|8)\s*\(\d{3,4}\)\s*[\d-]{5,9}/g, ' ');
  const short = bare.match(/(?<![\d-])1\d{2}(?![\d-])/g) ?? [];
  return [...long, ...short];
}

describe('FAQ «Что такое SOS-система на Камчатке?»', () => {
  it('ответ прочитан из миграции', () => {
    expect(ANSWER.length).toBeGreaterThan(300);
  });

  it('каждый номер в ответе — из единого списка проверенных', () => {
    const known = new Set(EMERGENCY_NUMBERS.map((n) => digits(n.phone)));
    const found = phonesIn(ANSWER);
    expect(found.length).toBeGreaterThanOrEqual(5);
    for (const p of found) expect(known.has(digits(p)), `номер не из emergency-numbers: ${p}`).toBe(true);
  });

  it('112 и все проверенные линии МЧС Камчатки на месте', () => {
    expect(phonesIn(ANSWER).map(digits)).toContain('112');
    for (const n of VERIFIED_REGIONAL) expect(ANSWER).toContain(n.phone);
  });

  it('ни номера рыбалки, ни непроверенного номера, ни обещания «уведомляются МЧС, КМПСС»', () => {
    expect(ANSWER).not.toMatch(/782-22-22|41-00-01|КМПСС/);
    expect(ANSWER).not.toMatch(/Уведомляются ближайшие спасательные структуры/);
    expect(ANSWER).not.toMatch(/tourhab|TourHab/i);
    expect(ANSWER).toMatch(/В МЧС и горноспасателям сигнал сам не передаётся/);
  });

  it('так и в коде: роут SOS пишет дежурному в Telegram и велит звонить 112', () => {
    const route = readFileSync(join(ROOT, 'app/api/safety/sos/route.ts'), 'utf-8');
    expect(route).toMatch(/sendMessage/);
    expect(route).toMatch(/Звоните 112/);
  });

  it('правится только строка с неверным номером — ручная правка не затирается', () => {
    expect(MIGRATION).toMatch(/WHERE question = 'Что такое SOS-система на Камчатке\?'\s+AND answer LIKE '%782-22-22%';/);
  });

  it('последующие миграции не возвращают номер рыбалки в FAQ', () => {
    const later = readdirSync(join(ROOT, 'migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f) && Number(f.split('_')[0]) > 1113);
    for (const f of later) {
      const src = readFileSync(join(ROOT, 'migrations', f), 'utf-8');
      if (/\bfaqs\b/.test(src)) expect(src, f).not.toMatch(/782-22-22|7822222/);
    }
  });
});
