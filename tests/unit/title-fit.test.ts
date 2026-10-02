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

  // Маршрут с 01.10 — обязательным хвостом (fitTitleRequired, ниже): без него
  // маршрут к источнику выходил в выдачу под именем самого места.
  it('карточка места: длинное имя остаётся без хвоста; маршрут — с обязательным', () => {
    const place = readFileSync(join(process.cwd(), 'app/places/[id]/page.tsx'), 'utf-8');
    const route = readFileSync(join(process.cwd(), 'app/routes/[id]/page.tsx'), 'utf-8');
    // 02.10: заголовок места собирает lib/seo/place-meta (хвост из ответов
    // карточки, по приоритету); fitTitle остался у планов, парков, маршрутов.
    expect(place).toMatch(/title: placeTitle\(facts\)/);
    expect(route).toMatch(/const title = fitTitleRequired\(route\.title, ROUTE_TITLE_TAILS\)/);
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

describe('обязательный хвост маршрута (аудит 01.10)', () => {
  it('маршрут с именем места не совпадает с местом даже при длинном имени', async () => {
    const { fitTitleRequired, ROUTE_TITLE_TAILS } = await import('@/lib/seo/title-fit');
    const twins = [
      'Большие Тюшевские термальные источники',
      'Нижне-Щапинские (Кипелые) термальные источники',
      'Верхне-Кошелевские парогидротермальные источники',
    ];
    for (const name of twins) {
      const route = fitTitleRequired(name, ROUTE_TITLE_TAILS);
      const place = fitTitle(name, [' — место на Камчатке']);
      expect(route, name).not.toBe(place);
      expect(route, name).toMatch(/ — маршрут/);
    }
  });

  it('помещается полный хвост — полный; короткое имя не теряет его', async () => {
    const { fitTitleRequired, ROUTE_TITLE_TAILS } = await import('@/lib/seo/title-fit');
    expect(fitTitleRequired('Вулкан Горелый', ROUTE_TITLE_TAILS)).toBe('Вулкан Горелый — маршрут на Камчатке');
    expect(fitTitleRequired('Большие Тюшевские термальные источники', ROUTE_TITLE_TAILS))
      .toBe('Большие Тюшевские термальные источники — маршрут');
  });

  it('страница маршрута зовёт обязательный хвост', () => {
    expect(readFileSync('app/routes/[id]/page.tsx', 'utf-8')).toMatch(/fitTitleRequired\(route\.title, ROUTE_TITLE_TAILS\)/);
  });
});
