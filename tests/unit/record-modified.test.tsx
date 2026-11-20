/**
 * Дата последней правки записи (SEO-аудит 20.11.2026, пункт 6): видимая строка
 * и dateModified — только из updated_at записи, без «сегодня» и даты сборки.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatRecordDate,
  parseRecordDate,
  recordDateIso,
  webPageModifiedJsonLd,
} from '@/lib/seo/record-modified';
import { RecordModified } from '@/components/seo/RecordModified';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('lib/seo/record-modified', () => {
  afterEach(() => vi.useRealTimers());

  it('пустое и мусорное значение — не дата', () => {
    for (const v of [null, undefined, '', 'не дата']) {
      expect(parseRecordDate(v)).toBeNull();
      expect(recordDateIso(v)).toBeNull();
      expect(formatRecordDate(v)).toBeNull();
    }
  });

  it('дата по камчатскому календарю (UTC+12), месяц в родительном падеже', () => {
    expect(formatRecordDate('2026-10-14T03:00:00Z')).toBe('14 октября 2026');
    // 13:00 UTC — на Камчатке уже следующий день.
    expect(formatRecordDate('2026-10-14T13:00:00Z')).toBe('15 октября 2026');
    expect(formatRecordDate(new Date('2025-12-31T12:30:00Z'))).toBe('1 января 2026');
  });

  it('результат не зависит от текущего времени — «сегодня» не подставляется', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect(formatRecordDate('2026-10-14T03:00:00Z')).toBe('14 октября 2026');
    expect(webPageModifiedJsonLd({ url: 'https://vedarai.ru/x', name: 'X', dateModified: null })).toBeNull();
  });

  it('узел WebPage несёт dateModified и ссылку на сущность карточки', () => {
    const ld = webPageModifiedJsonLd({
      url: 'https://vedarai.ru/places/abc',
      name: 'Озеро',
      dateModified: '2026-10-14T03:00:00Z',
      mainEntityId: 'https://vedarai.ru/places/abc',
    });
    expect(ld).toMatchObject({
      '@type': 'WebPage',
      '@id': 'https://vedarai.ru/places/abc#webpage',
      dateModified: '2026-10-14T03:00:00.000Z',
      mainEntity: { '@id': 'https://vedarai.ru/places/abc' },
    });
    const noEntity = webPageModifiedJsonLd({ url: 'https://vedarai.ru/a', name: 'A', dateModified: '2026-10-14' });
    expect(noEntity).not.toHaveProperty('mainEntity');
  });
});

describe('RecordModified', () => {
  it('рисует подпись и <time datetime>', () => {
    const html = renderToStaticMarkup(<RecordModified value="2026-10-14T03:00:00Z" />);
    expect(html).toContain('Последняя правка записи');
    expect(html).toContain('<time dateTime="2026-10-14T03:00:00.000Z">14 октября 2026</time>');
  });

  it('даты нет — нет и строки', () => {
    expect(renderToStaticMarkup(<RecordModified value={null} />)).toBe('');
    expect(renderToStaticMarkup(<RecordModified value="мусор" />)).toBe('');
  });
});

describe('подключение на карточках', () => {
  it('места: updated_at в запросе JSON-LD', () => {
    expect(src('app/places/[id]/page.tsx')).toMatch(/p\.updated_at/);
    expect(src('app/places/[id]/page.tsx')).toContain('webPageModifiedJsonLd');
  });

  it('маршруты: kr.updated_at → WebPage и проп строки', () => {
    const page = src('app/routes/[id]/page.tsx');
    expect(page).toMatch(/kr\.updated_at AS kr_updated_at/);
    expect(page).toContain('webPageModifiedJsonLd');
    expect(page).toContain('recordUpdatedAt=');
  });

  it('туры: ot.updated_at → узел в @graph', () => {
    expect(src('lib/tours/tour-detail-query.ts')).toMatch(/ot\.updated_at/);
    expect(src('app/catalog/tours/[id]/page.tsx')).toContain('webPageModifiedJsonLd');
  });

  it('статьи: updated_at в getArticle → WebPage и видимая строка', () => {
    expect(src('lib/articles/queries.ts')).toMatch(/source_name, updated_at\n\s+FROM articles\n\s+WHERE slug/);
    const page = src('app/articles/[slug]/page.tsx');
    expect(page).toContain('webPageModifiedJsonLd');
  });

  it('нигде не подставляется текущая дата', () => {
    for (const f of ['lib/seo/record-modified.ts', 'components/seo/RecordModified.tsx']) {
      expect(src(f)).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    }
  });
});
