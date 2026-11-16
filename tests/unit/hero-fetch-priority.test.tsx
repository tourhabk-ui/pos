// @vitest-environment jsdom
/**
 * Главный кадр карточки грузится первым (аудит 09.11, п. 5; слово владельца
 * 16.11 «карт-бланш»).
 *
 * `priority` у next/image в Next 15 даёт preload и eager-загрузку, но атрибут
 * `fetchpriority="high"` ставит только явный проп `fetchPriority`
 * (`next/dist/client/image-component.js`, `getDynamicProps`). Без него браузер
 * узнаёт о важности главного снимка поздно — а это самый крупный кадр первого
 * экрана карточки места.
 *
 * Сторож — рендером: первый кадр галереи и одиночный снимок несут
 * `fetchpriority="high"`, остальные кадры галереи — нет (они не на экране).
 * Герой тура и перевозчика (`HeroPhoto`) держит `media-no-stretch`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import PlaceHero from '@/components/places/PlaceHero';

afterEach(cleanup);

const BASE = {
  placeId: 'avachinsky',
  name: 'Авачинский вулкан',
  locationType: 'volcano',
  lat: 53.255,
  lng: 158.83,
  photoUrl: null,
  photoCount: 0,
};

function imgs(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll('img')].filter((i) => (i.getAttribute('alt') ?? '').startsWith('Авачинский'));
}

describe('карточка места: главный кадр — fetchpriority="high"', () => {
  it('галерея: первый кадр высокий, второй — нет', () => {
    const { container } = render(
      <PlaceHero {...BASE} images={['/api/images/s3/photos/a.jpg', '/api/images/s3/photos/b.jpg']} photoCount={2} />,
    );
    const [first, second] = imgs(container);
    expect(first?.getAttribute('fetchpriority')).toBe('high');
    expect(second?.getAttribute('fetchpriority')).toBeNull();
  });

  it('один снимок — высокий', () => {
    const { container } = render(
      <PlaceHero {...BASE} photoUrl="/api/images/s3/photos/a.jpg" photoCount={1} />,
    );
    const [only] = imgs(container);
    expect(only).toBeTruthy();
    expect(only!.getAttribute('fetchpriority')).toBe('high');
  });
});
