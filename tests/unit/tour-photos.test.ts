/**
 * Приписывание фото туру: только наши пути, откат в ответе, повтор безвреден.
 *
 * Фото на карточке — это обещание покупателю. Ручка, принимающая произвольный
 * URL, позволила бы повесить на карточку нашего проверенного оператора чужую
 * картинку с чужим водяным знаком, и заметили бы это не мы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isLocalImagePath, MAX_PHOTOS_PER_CALL } from '@/app/api/cron/tour-photos/route';

describe('чужой картинке на карточке не место', () => {
  it('наши пути принимаются', () => {
    expect(isLocalImagePath('/images/fishingkam/2026-08-23_autumn-1.jpg')).toBe(true);
  });

  it('чужой хост — нет', () => {
    expect(isLocalImagePath('https://example.com/a.jpg')).toBe(false);
    expect(isLocalImagePath('//example.com/a.jpg')).toBe(false);
  });

  it('выход вверх по дереву — нет', () => {
    expect(isLocalImagePath('/images/../../etc/passwd')).toBe(false);
  });

  it('путь мимо /images — нет', () => {
    expect(isLocalImagePath('/uploads/a.jpg')).toBe(false);
    expect(isLocalImagePath('images/a.jpg')).toBe(false);
  });
});

describe('правила ручки', () => {
  const SRC = readFileSync('app/api/cron/tour-photos/route.ts', 'utf8');

  it('сухой прогон по умолчанию', () => {
    expect(SRC).toMatch(/dry_run:\s*z\.boolean\(\)\.default\(true\)/);
  });

  it('источник и причина без умолчаний', () => {
    const head = SRC.slice(SRC.indexOf('const BodySchema'), SRC.indexOf('export async function POST'));
    expect(head).toMatch(/source:\s*z\.string\(\)[^\n]*\.min\(3/);
    expect(head).toMatch(/why:\s*z\.string\(\)[^\n]*\.min\(3/);
    expect(head).not.toContain("source: z.string().trim().default");
  });

  it('прежний массив возвращается — это откат', () => {
    expect(SRC).toContain('was,');
  });

  it('дубли не добавляются: повтор прогона не размножает фото', () => {
    expect(SRC).toContain('!was.includes(p)');
    expect(SRC).toContain('already_present');
  });

  it('партия ограничена', () => {
    expect(MAX_PHOTOS_PER_CALL).toBe(12);
  });
});

describe('фото не режутся по центру — голова остаётся в кадре', () => {
  const CARD = readFileSync('app/marketplace/tours/[id]/_TourDetailClient.tsx', 'utf8');

  it('у героя задана точка кадрирования', () => {
    // Фото операторов портретные (960x1280). object-cover без objectPosition
    // показывает вертикальную середину — то есть туловище без головы.
    const hero = CARD.slice(CARD.indexOf('photoSrc(heroImg, 1280)') - 400,
      CARD.indexOf('photoSrc(heroImg, 1280)') + 400);
    expect(hero).toContain("objectPosition: '50% 30%'");
  });

  it('у филмстрипа тоже', () => {
    const film = CARD.slice(CARD.indexOf('photoSrc(src, 640)') - 300,
      CARD.indexOf('photoSrc(src, 640)') + 400);
    expect(film).toContain("objectPosition: '50% 30%'");
  });
});

/**
 * Замечание владельца 29.09: «обрезал головы на фото туров — мы это пару
 * месяцев назад исправляли». Сторож выше держал только карточку тура, а плитки
 * туров на странице оператора, карточка каталога и /hub/fishing снова резали
 * портретные фото по центру. Теперь — каждая поверхность с фото тура: у
 * каждого object-cover рядом точка кадрирования из lib/tours/photo-focus.
 */
describe('все поверхности с фото туров держат голову в кадре', () => {
  const SURFACES = [
    'components/marketplace/MarketplaceClient.tsx',
    'app/operators/[slug]/page.tsx',
    'app/hub/fishing/_FishingPageClient.tsx',
    'app/ai-assistant/_AIAssistantClient.tsx',
  ];
  /** Элементы <Image …/> и <img …/> с object-cover, кроме логотипов (object-contain). */
  function coverImages(src: string): string[] {
    const tags = [...src.matchAll(/<(?:Image|img)\b[\s\S]*?\/>/g)].map((m) => m[0]);
    return tags.filter((t) => /object-cover/.test(t));
  }
  for (const f of SURFACES) {
    it(f, () => {
      const src = readFileSync(f, 'utf8');
      // Пейзажи — герой каталога и фото мест/маршрутов — не портреты туров.
      const imgs = coverImages(src).filter((t) => !/hero-marketplace\.jpg|route\.imageUrl/.test(t));
      expect(imgs.length, `${f}: не нашёл ни одного фото — сторож смотрит не туда`).toBeGreaterThan(0);
      for (const t of imgs) expect(t, `${f}: фото без точки кадрирования`).toMatch(/objectPosition:\s*TOUR_PHOTO_POSITION/);
      expect(src).toMatch(/from '@\/lib\/tours\/photo-focus'/);
    });
  }
  it('точка кадрирования — та же, что у карточки тура', async () => {
    const { TOUR_PHOTO_POSITION } = await import('@/lib/tours/photo-focus');
    expect(TOUR_PHOTO_POSITION).toBe('50% 30%');
  });
});
