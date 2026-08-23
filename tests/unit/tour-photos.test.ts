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
