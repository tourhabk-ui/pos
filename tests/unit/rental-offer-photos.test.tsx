// @vitest-environment jsdom
/**
 * Снимки машин проката (1319, владелец 23.10: «бери фото автомобилей»).
 *
 * Строка прайса показывает снимок машины вариантом 320 px с подписью автора;
 * без снимка — строка без картинки. Миграция кладёт обложку, галерею и снимки
 * машин «Лагуны Прокат» только в пустое, и каждый названный файл лежит в
 * public/images с нарезанными вариантами (иначе телефон тянул бы оригинал).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RentalOfferList } from '@/components/rental/RentalOfferList';
import type { RentalOffer } from '@/lib/rental/rental-format';
import manifest from '@/lib/images/photo-variants.json';

const offer = (over: Partial<RentalOffer> = {}): RentalOffer => ({
  id: 'o-1', title: 'Tank-300', bodyKind: 'suv', seats: 5, transmission: 'automatic', drive: '4wd', engineHp: 220,
  priceRubPerDay: 15000, priceIsFrom: false, depositRub: 30000, driver: 'self', conditions: null, sourceUrl: null,
  pricesSeenOn: null, photo: null, ...over,
});

describe('снимок машины в строке прайса', () => {
  it('есть снимок — картинка вариантом 320 с подписью автора; нет снимка — картинки нет', () => {
    const { container } = render(
      <RentalOfferList offers={[
        offer({ photo: { url: '/images/laguna-prokat/laguna-tank300-row.jpg', credit: 'Лагуна Прокат' } }),
        offer({ id: 'o-2', title: 'ГАЗ Соболь', bodyKind: 'minibus' }),
      ]} />,
    );
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    const img = screen.getByRole('img', { name: 'Tank-300: фото машины' });
    // next/image в jsdom заворачивает путь в /_next/image?url=…: судим по раскодированному адресу.
    expect(decodeURIComponent(img.getAttribute('src') ?? '')).toContain('/images/laguna-prokat/laguna-tank300-row.320.webp');
    expect(img.closest('[title]')?.getAttribute('title')).toBe('Фото: Лагуна Прокат');
    expect(screen.getByText('ГАЗ Соболь').closest('div')?.querySelector('img')).toBeNull();
  });

  it('снимок без подписи — картинка есть, выдуманной подписи нет', () => {
    const { container } = render(<RentalOfferList offers={[offer({ photo: { url: '/images/laguna-prokat/laguna-suzuki-jimny.jpg', credit: null } })]} />);
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('[title]')).toBeNull();
  });
});

describe('миграция 1319: фото «Лагуны Прокат»', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '1319_laguna_prokat_photos.sql'), 'utf-8');
  const paths = [...new Set(sql.match(/\/images\/laguna-prokat\/[a-z0-9-]+\.jpg/g) ?? [])];
  const widthsOf = new Map((manifest as Array<{ src: string; widths: number[] }>).map((e) => [e.src, e.widths]));

  it('колонка снимка заводится идемпотентно, записи — только в пустое', () => {
    expect(sql).toMatch(/ALTER TABLE car_rental_offers ADD COLUMN IF NOT EXISTS photo_url TEXT/);
    expect(sql).toMatch(/WHERE slug = 'laguna-prokat'\s+AND hero_image IS NULL/);
    expect(sql).toMatch(/AND o\.photo_url IS NULL/);
  });

  it('каждый названный снимок лежит в public/images с нарезанными вариантами и подписан', () => {
    expect(paths.length).toBeGreaterThanOrEqual(9);
    for (const p of paths) {
      expect(existsSync(join(process.cwd(), 'public', p)), p).toBe(true);
      expect(widthsOf.get(p), `${p}: нет в манифесте вариантов`).toContain(320);
      expect(sql, `${p}: нет подписи в gallery_credits`).toMatch(new RegExp(`'${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s+'Лагуна Прокат'`));
    }
  });

  it('у каждой из трёх машин прайса — свой снимок', () => {
    for (const title of ['Suzuki Jimny', 'Tank-300', 'Sever Truck']) {
      expect(sql).toMatch(new RegExp(`\\('${title}',\\s+'/images/laguna-prokat/[a-z0-9-]+\\.jpg'\\)`));
    }
  });
});
