/**
 * Сторож: снимки галерей открываются (владелец 09.10: «галерея не открывается»).
 *
 * Галерея страницы оператора рисовала фото блоками без нажатия; лента фото
 * перевозчика открывала сырой файл в новой вкладке; просмотрщик жил только в
 * карточке тура. Теперь он один (components/shared/PhotoLightbox), и все три
 * галереи его зовут. Сторож держит поведением: нажатие открывает снимок,
 * просмотрщик листает и за шестой плиткой, подпись автора идёт со снимком,
 * Esc закрывает.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));

import { OperatorGallery } from '@/components/operator/OperatorGallery';
import { CharterPhotos } from '@/components/transfers/CharterPhotos';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const urls = (n: number) => Array.from({ length: n }, (_, i) => `/images/shatun/shatun-0${i + 1}.jpg`);

afterEach(() => cleanup());

describe('галерея оператора', () => {
  it('плитка — кнопка: нажатие открывает снимок на весь экран', () => {
    render(<OperatorGallery images={urls(3)} name="Шатун" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото 2 из 3' }));
    expect(screen.getByRole('dialog', { name: 'Шатун: фото 2 из 3' })).toBeTruthy();
  });

  it('в сетке шесть, остальные — «+N», и просмотрщик доходит до последнего', () => {
    render(<OperatorGallery images={urls(8)} name="Шатун" />);
    expect(screen.getAllByRole('button', { name: /^Открыть фото/ })).toHaveLength(6);
    expect(screen.getByText('+2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото 6 из 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(screen.getByRole('dialog', { name: 'Шатун: фото 8 из 8' })).toBeTruthy();
  });

  it('подпись автора — под плиткой и в просмотрщике; Esc закрывает', () => {
    render(<OperatorGallery images={urls(2)} name="Шатун" captions={['Фото: Шатун', 'Фото: Сладченко Виктор Леонидович']} />);
    expect(screen.getByText('Фото: Сладченко Виктор Леонидович')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото 2 из 2' }));
    expect(screen.getAllByText('Фото: Сладченко Виктор Леонидович')).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('свайп листает', () => {
    render(<OperatorGallery images={urls(3)} name="Шатун" />);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото 1 из 3' }));
    const stage = screen.getByAltText('Шатун — фото 1').parentElement!;
    fireEvent.touchStart(stage, { touches: [{ clientX: 300 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 100 }] });
    expect(screen.getByRole('dialog', { name: 'Шатун: фото 2 из 3' })).toBeTruthy();
  });
});

describe('лента фото перевозчика', () => {
  it('снимок открывается в просмотрщике с подписью автора, а не файлом в новой вкладке', () => {
    const { container } = render(<CharterPhotos name="Шатун" photos={[
      { url: '/images/shatun/shatun-01.jpg', credit: null },
      { url: '/images/shatun/shatun-16.jpg', credit: 'Сладченко Виктор Леонидович' },
    ]} />);
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото 2 из 2' }));
    expect(screen.getByRole('dialog', { name: 'Шатун: фото 2 из 2' })).toBeTruthy();
    expect(screen.getAllByText('Фото: Сладченко Виктор Леонидович')).toHaveLength(2);
  });
});

describe('просмотрщик один на все галереи', () => {
  it('страница оператора зовёт галерею с просмотрщиком, а не рисует сетку без нажатия', () => {
    const page = read('app/operators/[slug]/page.tsx');
    expect(page).toMatch(/<OperatorGallery/);
    expect(page).not.toMatch(/gallery\.slice\(0, 6\)\.map/);
  });

  it('карточка тура — общий просмотрщик, своей копии нет', () => {
    const card = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
    expect(card).toMatch(/import \{ PhotoLightbox \} from '@\/components\/shared\/PhotoLightbox'/);
    expect(card).not.toMatch(/function Lightbox\(/);
  });
});
