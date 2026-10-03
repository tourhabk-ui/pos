/**
 * Сторож: Кузьмич знает свой сайт (скрин владельца 03.10, «гора Замок»).
 *
 * Турист попросил ссылку на гору Замок и получил «этот объект не оцифрован на
 * платформе… по цифрам не подскажу, чтобы не соврать» и выдуманную
 * «Налычевскую долину». Место при этом есть: карточка /places/…, координата
 * 53.183, 158.286. Механизм — в ответе инструмента, а не в поиске:
 * get_guardian_context отдавал имя, цвет и строку «Профиль безопасности для
 * этого места не оцифрован», без координат и без ссылки. Модель честно
 * пересказала то, что видела: «не оцифрован» — и страницы нет.
 *
 * Держится связка целиком: ссылка ведёт на ТУ запись, о которой ответ;
 * скрытое место ссылки и координат не получает; на MCP своя ссылка
 * (handoff), и вторую туда не пишем; строки «не оцифрован» больше нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGuardianContext, placePageUrl } from '@/lib/kuzmich/guardian-context';
import { composePlaceInfo } from '@/lib/kuzmich/place-info-tool';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const ZAMOK_ID = '5f0d2c1e-0000-4000-8000-000000000001';
const zamok = {
  id: ZAMOK_ID, is_visible: true, name: 'Гора Замок', location_type: 'mountain',
  lat: 53.18284, lng: 158.28647, recommender_status: 'yellow', description: null,
};

function placesReturn(rows: unknown[]) {
  mockQuery.mockImplementation((sql: string) =>
    Promise.resolve({ rows: sql.includes('FROM places') ? rows : [] }));
}

describe('страж места: координаты и ссылка', () => {
  beforeEach(() => vi.clearAllMocks());

  it('в чате — координаты и ссылка на карточку той же записи', async () => {
    placesReturn([zamok]);
    const ctx = await getGuardianContext('гора Замок', { pageLinks: true });
    expect(ctx).toContain('Координаты: 53.18284, 158.28647');
    expect(ctx).toContain(`Страница места на сайте: ${placePageUrl(ZAMOK_ID)}`);
  });

  it('на MCP — координаты есть, своей ссылки нет (там handoff)', async () => {
    placesReturn([zamok]);
    const ctx = await getGuardianContext('гора Замок');
    expect(ctx).toContain('Координаты: 53.18284, 158.28647');
    expect(ctx).not.toContain('Страница места на сайте');
  });

  it('скрытое место — ни координаты, ни ссылки', async () => {
    placesReturn([{ ...zamok, is_visible: false }]);
    const ctx = await getGuardianContext('гора Замок', { pageLinks: true });
    expect(ctx).not.toContain('Координаты:');
    expect(ctx).not.toContain('Страница места на сайте');
  });

  it('нет разметки опасностей — сказано, что место есть, а не «не оцифрован»', async () => {
    placesReturn([zamok]);
    const ctx = await getGuardianContext('гора Замок', { pageLinks: true });
    expect(ctx).toContain('Само место в справочнике есть');
    expect(ctx).not.toMatch(/не оцифрован/);
    expect(read('lib/kuzmich/guardian-context.ts')).not.toContain("'Профиль безопасности для этого места не оцифрован.'");
  });
});

describe('карточка места (get_place_info): ссылка', () => {
  const row = { id: ZAMOK_ID, name: 'Гора Замок', description: null, category: 'mountain', district: null, is_visible: true, lat: 53.18284, lng: 158.28647 };

  it('в чате — ссылка на эту запись', () => {
    const out = composePlaceInfo('гора Замок', [row], [], { pageLinks: true }) ?? '';
    expect(out).toContain(`Страница места на сайте: ${placePageUrl(ZAMOK_ID)}`);
  });

  it('без флага (MCP) — без ссылки; скрытое — без ссылки', () => {
    expect(composePlaceInfo('гора Замок', [row], []) ?? '').not.toContain('Страница места на сайте');
    expect(composePlaceInfo('гора Замок', [{ ...row, is_visible: false }], [], { pageLinks: true }) ?? '')
      .not.toContain('Страница места на сайте');
  });
});

describe('провод: чат просит ссылку, MCP — нет', () => {
  it('оба инструмента в executeTool получают pageLinks по поверхности', () => {
    const core = read('lib/kuzmich/core.ts');
    expect(core).toContain("placeInfoForKuzmich(placeName, { pageLinks: opts.surface !== 'mcp' })");
    expect(core).toContain("getGuardianContext(args.place ?? args.name ?? '', { pageLinks: opts.surface !== 'mcp' })");
  });

  it('адрес карточки строится от публичного домена', () => {
    expect(placePageUrl('abc')).toMatch(/^https:\/\/[^/]+\/places\/abc$/);
    expect(placePageUrl('abc')).not.toContain('twc1.net');
  });

  it('модель знает, что ссылка в ответе есть', () => {
    expect(read('lib/kuzmich/tool-schemas.ts')).toContain('ссылка на страницу места на сайте');
  });
});
