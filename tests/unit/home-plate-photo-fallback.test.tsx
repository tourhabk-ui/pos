// @vitest-environment jsdom
/**
 * Плитка главной не остаётся пустой рамкой, если снимок не дошёл (13.11).
 *
 * Владелец с телефона: у «Зимней рыбалки: ноябрь — январь» в «Турах сезона»
 * тёмная рамка без фото, хотя снимок цел и через минуты отдавался 200. Фон
 * (`background-image`) не умеет ни повторить запрос, ни сообщить об ошибке.
 * Сторож держит поведение: копия 640 → исходник → заглушка, точка кадра та же,
 * что была у фона.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlatePhoto, platePhotoChain } from '@/components/media/PlatePhoto';

afterEach(() => { cleanup(); });

// Снимок из жалобы: в манифесте есть копия 640, точки кадра нет.
const WINTER = '/api/images/s3/photos/fishingkam/2025-01-27_142818_1.jpg';
// Снимок с записанной точкой кадра.
const FOCUSED = '/api/images/s3/photos/fishingkam/2025-01-27_142551.jpg';
const UNKNOWN = '/images/tours/uploaded-later.jpg';

const fallback = <span data-testid="noimg" className="noimg" />;

function img(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img');
}

describe('снимок плитки главной', () => {
  it('сначала копия 640, затем исходник', () => {
    expect(platePhotoChain(WINTER)).toEqual([
      '/api/images/s3/photos/fishingkam/2025-01-27_142818_1.640.webp',
      WINTER,
    ]);
    expect(platePhotoChain(UNKNOWN)).toEqual([UNKNOWN]);
  });

  it('копия не дошла — исходник, не дошёл и он — заглушка', () => {
    const { container, queryByTestId } = render(<PlatePhoto src={WINTER} fallback={fallback} />);
    expect(img(container)?.getAttribute('src')).toBe('/api/images/s3/photos/fishingkam/2025-01-27_142818_1.640.webp');
    expect(queryByTestId('noimg')).toBeNull();

    fireEvent.error(img(container)!);
    expect(img(container)?.getAttribute('src')).toBe(WINTER);
    expect(queryByTestId('noimg')).toBeNull();

    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    expect(queryByTestId('noimg')).not.toBeNull();
  });

  it('снимок без копии после ошибки сразу уступает заглушке', () => {
    const { container, queryByTestId } = render(<PlatePhoto src={UNKNOWN} fallback={fallback} />);
    fireEvent.error(img(container)!);
    expect(queryByTestId('noimg')).not.toBeNull();
  });

  it('точка кадра та же, что была у фона: записанная или верх кадра', () => {
    const a = render(<PlatePhoto src={WINTER} fallback={fallback} />);
    expect(img(a.container)?.style.objectPosition).toBe('50% 0%');
    cleanup();
    const b = render(<PlatePhoto src={FOCUSED} fallback={fallback} />);
    expect(img(b.container)?.style.objectPosition).toBe('50% 55%');
  });

  it('снимок декоративный: подпись карточки рядом, чтецу он не нужен', () => {
    const { container } = render(<PlatePhoto src={WINTER} fallback={fallback} />);
    expect(img(container)?.getAttribute('alt')).toBe('');
  });
});

describe('главная не рисует снимок плитки фоном', () => {
  it('у фона нет запасного пути — только PlatePhoto', () => {
    const src = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
    expect(src).not.toMatch(/backgroundImage: `url\('\$\{photoSrc\(p\.imageUrl/);
    expect(src).not.toMatch(/tourPlateImageStyle/);
  });
});
