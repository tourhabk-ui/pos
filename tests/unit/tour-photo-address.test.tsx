// @vitest-environment jsdom
/**
 * Адрес снимка тура: что можно сохранить и что можно открыть (план готовности
 * 23.11, этап 4; находка ревью безопасности и её перепроверка 23.11).
 *
 * Очередь администратора ставит адрес снимка из правки партнёра в `src`
 * превью и в ссылку «открыть целиком»; после одобрения та же строка стоит в
 * `src` у каждого туриста.
 *
 * Первая находка — `javascript:…` в ссылке админки. Перепроверка нашла
 * соседнее: правило было отрицательным («не чужая схема») и пропускало любой
 * путь сайта. «Снимок» с адресом `/api/admin/…?action=…` браузер
 * администратора запросил бы сам, со своей кукой, без единого нажатия;
 * `/api/auth/magic?token=…` подменил бы сессию открывшего страницу.
 *
 * Теперь правило положительное: снимок — путь раздачи картинок сайта или
 * `https://хост/…`. Судится вызовом правила и двери и рендером экрана. Дверь
 * целиком на настоящем PostgreSQL — tests/integration/tour-moderation.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/database', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { TourEditDiff, TourEditPhotos, TourEditValue } from '@/components/tours/TourEditDiff';
import {
  externalPhotoHref, openablePhotoAddress, photoAddressHasForeignScheme, photoAddressesOf,
  rejectedPhotoAddresses, sitePhotoPath, PHOTO_ADDRESS_TEXT,
} from '@/lib/tours/photo-address';
import { CreateTourSchema, UpdateTourSchema } from '@/lib/api/operator-tours';

afterEach(() => cleanup());

/** Чужая схема: исполнить или прочитать то, что снимком не является. */
const FOREIGN_SCHEME = [
  'javascript:alert(1)',
  'JAVASCRIPT:alert(1)',
  '  javascript:alert(1)',
  '\u0000javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  // Разбор URL на этих строках бросает исключение: прежде это читалось как «схемы нет».
  'javascript://x y/%0Aalert(1)',
  'javascript://[/%0Aalert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://vedarai.ru/1b2c',
  'ftp://example.com/a.jpg',
];

/** Путь нашего сайта, который не раздаёт картинки: запрос по нему что-то делает или отдаёт чужое. */
const SITE_NOT_PHOTO = [
  '/api/admin/evo?action=rescue-scan',
  '/api/admin/telegram/diagnose',
  '/api/auth/magic?token=abc',
  '/api/auth/signout',
  '/hub/admin/operators',
  '/catalog',
  '/',
  // Каталог картинок, но с параметрами, якорем или выходом из каталога.
  '/images/tours/a.jpg?next=/api/admin/evo',
  '/api/images/s3/photos/a.jpg#x',
  '/images/../api/admin/evo',
  '/images/tours/..',
  '/images/%2e%2e/api/admin/evo',
  '/images/tours%2f..%2f..%2fapi/admin',
  '/images/tours/a%00.jpg',
  '/images/tours/a b.jpg',
  '/images/tours\\a.jpg',
];

/** Одна строка — два адреса: экран и браузер туриста прочли бы её по-разному. */
const AMBIGUOUS = [
  '//evil.example/a.jpg',
  '///evil.example/a.jpg',
  '/\\evil.example/a.jpg',
  '\\\\evil.example\\a.jpg',
  'https:evil.example/a.jpg',
  'https:/evil.example/a.jpg',
  'https:\\\\evil.example\\a.jpg',
  'https://vedarai.ru@evil.example/a.jpg',
  'https://user:pass@evil.example/a.jpg',
  'https:// evil.example/a.jpg',
  'https://',
  'http://example.com/photo.jpg',
  'photo.jpg',
  'images/tours/a.jpg',
  '',
  ' ',
];

const HOSTILE = [...FOREIGN_SCHEME, ...SITE_NOT_PHOTO, ...AMBIGUOUS];

const SITE_PATHS = [
  '/images/tours/a.jpg',
  '/images/operators/kamchatka/hero-1.640.webp',
  '/api/images/s3/photos/partner/a.640.webp',
  '/api/photos/images/tours/a.jpg',
  '/images/туры/вулкан_(1).jpg',
  '/images/tours/a%20b.jpg',
];
const WEB = [
  'https://s3.twcstorage.ru/bucket/images/tours/a.jpg',
  'https://example.com/photo.jpg',
  'https://example.com/photo.jpg?w=640&h=480',
];

describe('правило адреса снимка', () => {
  it('снимок — путь раздачи картинок сайта или https://хост/…, и только они', () => {
    for (const url of SITE_PATHS) {
      expect(sitePhotoPath(url), url).toBe(url);
      expect(openablePhotoAddress(url), url).toBe(url);
    }
    for (const url of WEB) {
      expect(externalPhotoHref(url), url).toBe(url);
      expect(openablePhotoAddress(url), url).toBe(url);
    }
    for (const url of HOSTILE) expect(openablePhotoAddress(url), JSON.stringify(url)).toBeNull();
    for (const url of [null, undefined, 7, {}, ['/images/tours/a.jpg'], true]) {
      expect(openablePhotoAddress(url), JSON.stringify(url)).toBeNull();
    }
  });

  it('путь сайта вне каталогов картинок снимком не является — ни ручка администратора, ни вход по ссылке', () => {
    for (const url of SITE_NOT_PHOTO) {
      expect(sitePhotoPath(url), url).toBeNull();
      expect(externalPhotoHref(url), url).toBeNull();
    }
  });

  it('внешний снимок записан полностью: https://, хост, без имени и пароля', () => {
    for (const url of AMBIGUOUS) expect(externalPhotoHref(url), JSON.stringify(url)).toBeNull();
    // Что вернул разбор — то и уйдёт в вёрстку: строка, равная исходной.
    expect(externalPhotoHref('https://EXAMPLE.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  it('чужая схема читается глазами браузера, а не разбором URL; строка без схемы чужой схемы не несёт', () => {
    for (const url of FOREIGN_SCHEME) expect(photoAddressHasForeignScheme(url), JSON.stringify(url)).toBe(true);
    for (const url of [...SITE_PATHS, ...WEB, 'http://example.com/a.jpg', 'photo.jpg', 'images/a.jpg', '/api/admin/evo?action=x', '//evil.example/a.jpg', '']) {
      expect(photoAddressHasForeignScheme(url), url).toBe(false);
    }
  });

  it('правка: судится только новый адрес; тот, что уже стоит у тура, остаётся как есть', () => {
    const known = new Set(['photo.jpg', '/old/legacy.png', '/images/tours/a.jpg']);
    // Форма прислала снимки обратно — отвергать нечего.
    expect(rejectedPhotoAddresses(['photo.jpg', '/old/legacy.png', '/images/tours/a.jpg'], known)).toEqual([]);
    // Новый настоящий снимок — принят.
    expect(rejectedPhotoAddresses(['photo.jpg', '/images/tours/b.jpg', 'https://example.com/c.jpg'], known)).toEqual([]);
    // Новый «снимок», который снимком не является, — назван.
    expect(rejectedPhotoAddresses(['photo.jpg', '/api/admin/evo?action=rescue-scan', '//evil.example/a.jpg'], known))
      .toEqual(['/api/admin/evo?action=rescue-scan', '//evil.example/a.jpg']);
    // У нового тура известных адресов нет: старая запись без пути — тоже отказ.
    expect(rejectedPhotoAddresses(['photo.jpg'], new Set())).toEqual(['photo.jpg']);
    // Не-строки сюда не доходят и адресом не считаются.
    expect(rejectedPhotoAddresses([null, 7, {}], new Set())).toEqual([]);
  });

  it('адреса тура — снимки и обложка; не-строки и чужие поля не считаются', () => {
    expect(photoAddressesOf({ photos: ['/images/tours/a.jpg', 7, null, 'b.jpg'], tour_image: '/images/tours/c.jpg', title: 'Тур' }))
      .toEqual(['/images/tours/a.jpg', 'b.jpg', '/images/tours/c.jpg']);
    expect(photoAddressesOf({ photos: 'не массив', tour_image: null })).toEqual([]);
    expect(photoAddressesOf(null)).toEqual([]);
    expect(photoAddressesOf(undefined)).toEqual([]);
  });
});

describe('дверь оператора: адрес снимка', () => {
  const firstError = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) => r.error?.issues[0]?.message;

  it('новый тур: принимается только снимок — у обоих полей', () => {
    for (const url of HOSTILE) {
      expect(CreateTourSchema.shape.photos.safeParse([url]).success, JSON.stringify(url)).toBe(false);
      expect(CreateTourSchema.shape.tour_image.safeParse(url).success, JSON.stringify(url)).toBe(false);
    }
    for (const url of [...SITE_PATHS, ...WEB]) {
      expect(CreateTourSchema.shape.photos.safeParse([url]).success, url).toBe(true);
      expect(CreateTourSchema.shape.tour_image.safeParse(url).success, url).toBe(true);
    }
    expect(firstError(CreateTourSchema.shape.photos.safeParse(['/api/admin/evo?action=rescue-scan']))).toBe(PHOTO_ADDRESS_TEXT);
  });

  it('правка тура, схема: чужая схема отклонена словами — у снимков и у обложки', () => {
    for (const url of FOREIGN_SCHEME) {
      const photos = UpdateTourSchema.safeParse({ photos: ['/images/tours/a.jpg', url] });
      expect(photos.success, JSON.stringify(url)).toBe(false);
      expect(firstError(photos)).toBe(PHOTO_ADDRESS_TEXT);
      const cover = UpdateTourSchema.safeParse({ tour_image: url });
      expect(cover.success, JSON.stringify(url)).toBe(false);
      expect(firstError(cover)).toBe(PHOTO_ADDRESS_TEXT);
    }
  });

  it('правка тура, схема: старая запись без пути форму не запирает — её судит роут по снимкам тура', () => {
    expect(UpdateTourSchema.safeParse({ photos: [...SITE_PATHS, ...WEB] }).success).toBe(true);
    expect(UpdateTourSchema.safeParse({ tour_image: null }).success).toBe(true);
    expect(UpdateTourSchema.safeParse({ photos: [] }).success).toBe(true);
    expect(UpdateTourSchema.safeParse({ photos: ['photo.jpg'] }).success).toBe(true);
  });
});

describe('очередь администратора: снимки правки', () => {
  /** Всё, что браузер может исполнить или загрузить из вёрстки. */
  const targets = () => [...document.querySelectorAll('[href], [src], [action], [formaction], [srcset], [poster], [style]')]
    .map((el) => el.getAttribute('href') ?? el.getAttribute('src') ?? el.getAttribute('action')
      ?? el.getAttribute('formaction') ?? el.getAttribute('srcset') ?? el.getAttribute('poster') ?? el.getAttribute('style') ?? '');

  it('снимок сайта или https: превью и ссылка «открыть целиком»; адрес проверки чужому серверу не сообщается', () => {
    render(<TourEditPhotos urls={['/images/tours/a.jpg', 'https://example.com/b.jpg']} label="Фото: станет" />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/images/tours/a.jpg', 'https://example.com/b.jpg']);
    const images = screen.getAllByRole('img');
    expect(images.map((i) => i.getAttribute('src'))).toEqual(['/images/tours/a.jpg', 'https://example.com/b.jpg']);
    for (const a of links) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    for (const i of images) expect(i.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.queryByTestId('photo-not-openable')).toBeNull();
  });

  it.each(HOSTILE.filter((u) => u.trim() !== '').map((u) => [u]))('адрес %j: ни ссылки, ни картинки — только текст и пометка', (url) => {
    render(<TourEditPhotos urls={[url]} label="Фото: станет" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    // Браузер не запросит и не исполнит ничего: в вёрстке нет ни одного адреса.
    expect(targets()).toEqual([]);
    const note = screen.getByTestId('photo-not-openable');
    expect(note.textContent).toContain('Адрес снимка не открывается');
    // Что прислал партнёр, администратор видит — текстом.
    expect(note.textContent).toContain(url);
  });

  it('безопасный и небезопасный рядом: первый открыт, остальные — текст', () => {
    render(<TourEditPhotos urls={['/images/tours/a.jpg', 'javascript:alert(1)', '/api/admin/evo?action=rescue-scan', 'photo.jpg']} label="Фото" />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getAllByTestId('photo-not-openable')).toHaveLength(3);
    expect(targets().every((t) => t === '/images/tours/a.jpg')).toBe(true);
  });

  it('тем же правилом — значение поля и дифф «сейчас / станет»', () => {
    render(<TourEditValue text="" photos={['/api/auth/magic?token=abc']} label="Обложка" />);
    expect(targets()).toEqual([]);
    cleanup();
    render(<TourEditDiff changes={[{
      field: 'photos', label: 'Фото', before: '', after: '',
      beforePhotos: ['/images/tours/a.jpg'], afterPhotos: ['javascript:alert(1)', '/api/admin/evo?action=rescue-scan'],
    } as never]} />);
    expect(targets()).toEqual(['/images/tours/a.jpg', '/images/tours/a.jpg']);
    expect(screen.getAllByTestId('photo-not-openable')).toHaveLength(2);
  });
});
