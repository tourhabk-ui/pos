/**
 * Цитируемый ответ — в первом экране карточки тура.
 *
 * SEO-аудит 06.08 (методология seo-geo): AI-поиск берёт ~44% цитат из первых
 * 30% страницы, а на карточке выше сгиба стояло только название на фото —
 * самодостаточный абзац появлялся ниже. Владелец: «short_description выведи».
 *
 * short_description — подтверждённое описание оператора, готовый цитируемый
 * блок из данных (§8: ничего не выдумываем). Из «О туре» он ушёл: один и тот
 * же абзац дважды на странице — расходящийся дубль в будущем.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CARD = readFileSync(
  join(process.cwd(), 'app/marketplace/tours/[id]/_TourDetailClient.tsx'),
  'utf-8',
);

describe('герой карточки тура', () => {
  it('short_description стоит в герое, сразу после H1', () => {
    const h1 = CARD.indexOf('<h1');
    const firstUse = CARD.indexOf('tour.short_description &&');
    expect(h1).toBeGreaterThan(0);
    expect(firstUse).toBeGreaterThan(h1);
    // Между H1 и абзацем — не больше одного экрана кода: это тот же блок героя.
    expect(firstUse - h1).toBeLessThan(1500);
  });

  it('в «О туре» дубля больше нет — абзац на странице один', () => {
    const uses = CARD.match(/tour\.short_description &&/g) ?? [];
    expect(uses.length).toBe(1);
  });

  it('стандарт §11 синхронизирован', () => {
    const claude = readFileSync(join(process.cwd(), 'CLAUDE.md'), 'utf-8');
    expect(claude).toMatch(/short_description[\s\S]{0,40}ГЕРОЕ/);
  });
});
