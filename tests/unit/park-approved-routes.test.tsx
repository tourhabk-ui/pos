// @vitest-environment node
/**
 * Утверждённые маршруты парков (20.11): одни слова на карточке, у Кузьмича и в
 * MCP; «не нашли» — не «запрещён»; статус открыт/закрыт не утверждается;
 * отказ чтения — молчание, а не «не значится».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { ParkApprovedRoute } from '@/components/routes/ParkApprovedRoute';
import {
  APPROVED_ROUTES_SOURCE, PARK_RULE_QUOTE, approvedRouteCaseFor, approvedRouteLines, variantWords, type ApprovedVariant,
} from '@/lib/parks/approved-routes';

const v = (o: Partial<ApprovedVariant>): ApprovedVariant => ({
  parkName: 'Природный парк «Вилючинский»', title: 'Вилючинский водопад', season: 'summer', period: 'июнь-октябрь',
  movement: 'Пешком', passportUrls: ['https://www.vulcanikamchatki.ru/files/p1.pdf'], trackUrl: 'https://www.vulcanikamchatki.ru/files/t1.zip',
  sourceUrl: APPROVED_ROUTES_SOURCE, readOn: '2026-11-20', ...o,
});
const row = (o: Partial<ApprovedVariant>) => {
  const x = v(o);
  return { park_name: x.parkName, title: x.title, season: x.season, period: x.period, movement: x.movement, passport_urls: x.passportUrls, track_url: x.trackUrl, source_url: x.sourceUrl, read_on: x.readOn };
};

beforeEach(() => query.mockReset());

describe('случай маршрута', () => {
  it('связан — варианты из базы', async () => {
    query.mockResolvedValueOnce({ rows: [row({}), row({ season: 'winter', period: 'декабрь-май', movement: 'На лыжах, пешком, на снегоходе' })] });
    const c = await approvedRouteCaseFor('r1', 'vilyuchinsky', 'Природный парк «Вилючинский»');
    expect(c).toMatchObject({ kind: 'linked' });
    expect(c!.kind === 'linked' && c!.variants.map((x) => x.season)).toEqual(['summer', 'winter']);
  });
  it('в парке из трёх, связи нет — «не нашли», не «запрещён»', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const c = await approvedRouteCaseFor('r2', 'nalychevo', 'Природный парк «Налычево»');
    expect(c).toEqual({ kind: 'not_listed', parkName: 'Природный парк «Налычево»', sourceUrl: APPROVED_ROUTES_SOURCE });
    const line = approvedRouteLines(c).join(' ');
    expect(line).toContain('мы этот маршрут не нашли');
    expect(line).not.toMatch(/запрещ/);
    expect(line).toContain(PARK_RULE_QUOTE);
  });
  it('вне трёх парков — ничего; отказ базы — ничего (молчание, а не «не значится»)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await approvedRouteCaseFor('r3', 'yuzhno-kamchatsky', 'Южно-Камчатский')).toBeNull();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
    expect(await approvedRouteCaseFor('r4', 'nalychevo', 'Налычево')).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[approved-routes]'), 'SQLSTATE=57014', 'boom');
    err.mockRestore();
  });
});

describe('слова', () => {
  it('вариант: сезон, период, способ; пустое — «не указан»', () => {
    expect(variantWords(v({}))).toBe('летом (июнь-октябрь): Пешком');
    expect(variantWords(v({ season: 'winter', period: null, movement: null }))).toBe('зимой: способ передвижения на странице парка не указан');
  });
  it('связан: маршрут парка, варианты, источник с датой; статус не утверждается', () => {
    const lines = approvedRouteLines({ kind: 'linked', variants: [v({}), v({ season: 'winter', period: 'декабрь-май', movement: 'На лыжах' })] });
    expect(lines[0]).toBe('Утверждённый маршрут парка (Природный парк «Вилючинский»): «Вилючинский водопад» — летом (июнь-октябрь): Пешком; зимой (декабрь-май): На лыжах.');
    expect(lines[1]).toContain('прочитано 20.11.2026');
    expect(lines.join(' ')).not.toMatch(/открыт|закрыт/);
  });
});

describe('блок на карточке', () => {
  it('связан: паспорт и трек ссылками, источник и оговорка про статус', () => {
    const html = renderToStaticMarkup(<ParkApprovedRoute approved={{ kind: 'linked', variants: [v({})] }} />);
    expect(html).toContain('Утверждённый маршрут парка</h2>');
    expect(html).toContain('href="https://www.vulcanikamchatki.ru/files/p1.pdf"');
    expect(html).toContain('href="https://www.vulcanikamchatki.ru/files/t1.zip"');
    expect(html).toContain('прочитано 20.11.2026');
    expect(html).toContain('Открыт ли маршрут сейчас, уточняйте у парка.');
  });
  it('не нашли — так и сказано; нет случая — блока нет', () => {
    const html = renderToStaticMarkup(<ParkApprovedRoute approved={{ kind: 'not_listed', parkName: 'Природный парк «Налычево»', sourceUrl: APPROVED_ROUTES_SOURCE }} />);
    expect(html).toContain('мы этот маршрут не нашли');
    expect(renderToStaticMarkup(<ParkApprovedRoute approved={null} />)).toBe('');
  });
});
