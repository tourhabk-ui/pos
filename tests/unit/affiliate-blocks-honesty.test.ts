/**
 * Партнёрские блоки: настоящие ссылки, маркировка рекламы, никаких выдуманных
 * цен и несуществующих трансферов.
 *
 * Аудит 28.07 по просьбе владельца. На публичной странице /partners жили четыре
 * блока, собранные из констант:
 *   - цены авиабилетов из PRICE_CACHE с last_updated '2026-03-31' — четыре
 *     месяца назад, обновлять их было нечему;
 *   - четыре отеля Петропавловска с выдуманными звёздами, удобствами и ценами,
 *     все ведущие на одну общую ссылку Островка;
 *   - страховки «basic/silver/gold» с несуществующим параметром ?plan=;
 *   - трансферы, среди которых «Центр → Курильское озеро, 100 км, 180 минут,
 *     5000 ₽». Автомобильной дороги на Курильское озеро нет — туда летают
 *     вертолётом, а посещение требует разрешения Кроноцкого заповедника,
 *     ссылку на которое платформа сама же и хранит (миграция 781).
 * Ни в одном из четырёх не было ни erid, ни пометки «Реклама».
 *
 * Для safety-платформы выдуманная география — не маркетинговая неточность:
 * турист, поверивший в трансфер за 5000 ₽, поедет и не доедет.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const abs = (p: string) => join(process.cwd(), p);
const read = (p: string) => readFileSync(abs(p), 'utf-8');

const PARTNERS_PAGE = read('app/partners/_PartnersClient.tsx');
const AFFILIATE = read('components/routes/RouteAffiliateBlock.tsx');
const YANDEX = read('components/routes/YandexTravelBlock.tsx');
const TOUR = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');

const REMOVED = [
  'components/routes/FlightsBlock.tsx',
  'components/routes/HotelsBlock.tsx',
  'components/routes/InsuranceBlock.tsx',
  'components/routes/TransfersBlock.tsx',
  'lib/services/flights.service.ts',
  'lib/services/hotels.service.ts',
  'lib/services/insurance.service.ts',
  'lib/services/transfers.service.ts',
];

describe('выдуманные блоки не вернулись', () => {
  it('файлы с придуманными ценами и трансферами удалены', () => {
    for (const p of REMOVED) {
      expect(existsSync(abs(p)), `${p} снова на месте`).toBe(false);
    }
  });

  it('страница партнёров их не подключает', () => {
    for (const name of ['FlightsBlock', 'HotelsBlock', 'InsuranceBlock', 'TransfersBlock']) {
      expect(PARTNERS_PAGE).not.toContain(name);
    }
  });

  it('вместо них — блок с реальными партнёрскими ссылками', () => {
    expect(PARTNERS_PAGE).toContain('RouteAffiliateBlock');
    expect(PARTNERS_PAGE).toContain('YandexTravelBlock');
  });
});

describe('живые блоки размечены как реклама', () => {
  it('Яндекс-блок несёт erid и пометку', () => {
    expect(YANDEX).toContain('erid=');
    expect(YANDEX).toContain('Реклама');
  });

  it('партнёрский блок несёт пометку с реквизитами', () => {
    expect(AFFILIATE).toContain('Реклама');
    expect(AFFILIATE).toContain('ИНН');
  });
});

describe('партнёрские ссылки не теряют атрибуцию', () => {
  const MARKER = '402896';

  it('каждая внешняя ссылка блока несёт наш идентификатор', () => {
    // Читаем исходник, поэтому идентификатор встречается и подставленным
    // числом, и подстановкой ${MARKER} / ${TP_SUBID} — годится любая форма,
    // важно что ссылка не безымянная: без неё клик уходит бесплатно.
    const urls = [...AFFILIATE.matchAll(/url:\s*`([^`]+)`/g)].map(m => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const attributed = u.includes(MARKER) || u.includes('${MARKER}') || u.includes('${TP_SUBID}');
      expect(attributed, `ссылка без маркера: ${u}`).toBe(true);
    }
  });
});

describe('карточка тура', () => {
  it('показывает только проверенные партнёрские блоки', () => {
    expect(TOUR).toContain('RouteAffiliateBlock');
    expect(TOUR).toContain('YandexTravelBlock');
    expect(TOUR).not.toContain('FlightsBlock');
    expect(TOUR).not.toContain('TransfersBlock');
  });
});
