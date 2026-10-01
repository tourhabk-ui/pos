/**
 * Заголовок плана помещается в выдачу (аудит vedarai.ru 01.10: 86–91 знак
 * при видимых ~60 — хвост и название сайта обрезались многоточием).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitTitle, PLAN_TITLE_TAILS, TITLE_LIMIT, BRAND_SUFFIX } from '@/lib/seo/title-fit';
import { PLAN_PRESETS } from '@/lib/plans/presets';

describe('fitTitle', () => {
  it('у каждого плана заголовок с « | Ведар» не длиннее предела', () => {
    for (const p of PLAN_PRESETS) {
      const t = fitTitle(p.title, PLAN_TITLE_TAILS) + BRAND_SUFFIX;
      expect(t.length, t).toBeLessThanOrEqual(TITLE_LIMIT);
      expect(t.startsWith(p.title)).toBe(true);
    }
  });

  it('берёт самый длинный хвост, который помещается', () => {
    const short = 'Камчатка за 5 дней: медведи и океан'; // 35 знаков
    expect(fitTitle(short, PLAN_TITLE_TAILS)).toBe(`${short} — готовый план`);
    const tiny = 'Камчатка';
    expect(fitTitle(tiny, PLAN_TITLE_TAILS)).toBe(`${tiny} — готовый план с турами и ценами`);
  });

  it('не помещается ни один хвост — заголовок без хвоста, не обрезанный', () => {
    const long = 'Очень длинное название плана поездки на Камчатку, которое занимает всё место';
    expect(fitTitle(long, PLAN_TITLE_TAILS)).toBe(long);
  });

  it('карточки места и маршрута — тем же правилом: длинное имя остаётся без хвоста', () => {
    const place = readFileSync(join(process.cwd(), 'app/places/[id]/page.tsx'), 'utf-8');
    const route = readFileSync(join(process.cwd(), 'app/routes/[id]/page.tsx'), 'utf-8');
    expect(place).toMatch(/title: fitTitle\(r\.name as string, \[' — место на Камчатке'\]\)/);
    expect(route).toMatch(/const title = fitTitle\(route\.title, \[' — маршрут на Камчатке'\]\)/);
    const longName = 'Командорский государственный природный биосферный заповедник';
    expect(fitTitle(longName, [' — место на Камчатке'])).toBe(longName);
    expect(fitTitle('Вулкан Горелый', [' — место на Камчатке'])).toBe('Вулкан Горелый — место на Камчатке');
  });

  it('страница плана берёт заголовок отсюда', () => {
    const page = readFileSync(join(process.cwd(), 'app/plans/[slug]/page.tsx'), 'utf-8');
    expect(page).toMatch(/title: fitTitle\(preset\.title, PLAN_TITLE_TAILS\)/);
    expect(page).not.toMatch(/— готовый план с турами и ценами`/);
  });
});
