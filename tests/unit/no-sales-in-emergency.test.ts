/**
 * При признаках ЧП Кузьмич ничего не продаёт (разбор 24.09).
 *
 * «Я турист, заблудился у Авачинского» получало блок 112 и карточки туров
 * в одном ответе: подстрока «тур» сидит в слове «турист», а «медвед» — в
 * ключах интереса к туру, так что «медведь у палатки» тянул туры на медведей.
 * Держится двумя слоями: интерес к туру не видит «турист», и при ЧП пути
 * продажи закрыты независимо от ключевых слов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectTourIntent } from '@/lib/ai/booking-intent';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('интерес к туру не видит «турист»', () => {
  it('«турист» и «tourist» — не интерес к туру', () => {
    expect(detectTourIntent('Я турист, заблудился у Авачинского').detected).toBe(false);
    expect(detectTourIntent('I am a tourist and lost').detected).toBe(false);
  });

  it('«тур», «туры», «турбаза», «tour» — по-прежнему интерес', () => {
    for (const t of ['хочу тур на вулкан', 'туры на медведей', 'турбаза у озера', 'book a tour']) {
      expect(detectTourIntent(t).detected, t).toBe(true);
    }
  });
});

describe('при ЧП пути продажи закрыты', () => {
  const chat = read('app/api/ai/chat/route.ts');

  it('флаг ЧП считается тем же детектором, что даёт блок 112', () => {
    expect(chat).toMatch(/const emergencyNow = detectEmergency\(rawMessage\)\.detected/);
  });

  it('агент бронирования не запускается при ЧП', () => {
    expect(chat).toMatch(/if \(!answer && safeRole === 'tourist' && isAuthenticated && !emergencyNow\)/);
  });

  it('карточки туров (и форма брони из них) не показываются при ЧП', () => {
    expect(chat).toMatch(/if \(safeRole === 'tourist' && !emergencyNow\) \{\s*const intentResult = detectTourIntent\(rawMessage\)/);
    expect(chat).toMatch(/const bookingFormTour = bookingTriggered && tourSuggestions\.length > 0/);
  });

  it('туры не идут в контекст модели при ЧП — во всех трёх входах чата', () => {
    expect(read('lib/ai/rag-context.ts')).toMatch(/intent\.detected && !detectEmergency\(message\)\.detected\s*\?\s*findRelevantTours/);
  });
});
