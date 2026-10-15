// @vitest-environment node
/**
 * Китайский HTML-вход /zh (карт-бланш владельца 12.10: «подключить китайцев»).
 *
 * Проба 12.10: DeepSeek и Qwen о vedarai.ru не знают. Поисковики КНР
 * индексируют HTML, а не llms.txt и не манифест — до /zh китайской страницы
 * не было. Сторож держит связку: текст страницы — из lib/mcp/zh-layer (один
 * источник, не вторая копия), метаданные по-китайски с canonical и hreflang,
 * главная знает о /zh, sitemap её называет, OpenAPI несёт китайский абзац,
 * каталог на странице — живой под гейтом витрины с честным отказом (§4.0),
 * команда Qwen Code — из lib/mcp/connect, в тексте нет ни телефона, ни почты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZH_PAGE, OPENAPI_DESCRIPTION_ZH } from '@/lib/mcp/zh-layer';
import { priceZh, durationZh, PRICE_UNIT_ZH } from '@/lib/zh/entry';
import { ZH_PAGE_PATHS } from '@/lib/zh/pages';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PAGE = read('app/zh/page.tsx');
const ENTRY = read('lib/zh/entry.ts');
const HAN = /[一-鿿]/;
const PHONE = /\+7\s?\d|\b8\s?\(?9\d{2}\)?/;
const EMAIL = /@[a-z0-9.-]+\.[a-z]{2,}/i;

describe('тексты страницы — один источник, без ПД и выдумки', () => {
  it('заголовок и описание по-китайски, описание не длиннее 160 знаков, 112 на месте', () => {
    expect(ZH_PAGE.title).toMatch(HAN);
    expect(ZH_PAGE.title).toContain('堪察加');
    expect(ZH_PAGE.description.length).toBeLessThanOrEqual(160);
    expect(ZH_PAGE.description).toContain('112');
    expect(ZH_PAGE.emergency).toContain('112');
    expect(ZH_PAGE.capabilities.length).toBeGreaterThanOrEqual(3);
  });

  it('четыре заявки названы именами инструментов, оплаты нет', () => {
    for (const t of ['create_lead', 'create_booking_request', 'create_stay_request', 'request_charter']) {
      expect(ZH_PAGE.booking).toContain(t);
      expect(OPENAPI_DESCRIPTION_ZH).toContain(t);
    }
    expect(ZH_PAGE.booking).toMatch(/无在线支付/);
    expect(OPENAPI_DESCRIPTION_ZH).toMatch(HAN);
    expect(OPENAPI_DESCRIPTION_ZH).toContain('112');
  });

  it('ни телефона, ни почты ни в одной строке', () => {
    const all = [ZH_PAGE.title, ZH_PAGE.description, ZH_PAGE.booking, ZH_PAGE.agents, ZH_PAGE.langNote, ...ZH_PAGE.capabilities, OPENAPI_DESCRIPTION_ZH].join('\n');
    expect(all).not.toMatch(PHONE);
    expect(all).not.toMatch(EMAIL);
  });

  it('страница печатает текст из zh-layer, а не свою копию описания платформы', () => {
    expect(PAGE).toContain("from '@/lib/mcp/zh-layer'");
    expect(PAGE).toContain('{MCP_DESCRIPTION_ZH}');
    expect(PAGE).toContain('{ZH_PAGE.booking}');
    expect(PAGE).toContain('{ZH_PAGE.agents}');
    expect(PAGE).not.toContain('堪察加旅游平台：');
  });
});

describe('метаданные и обнаружение', () => {
  it('lang zh-CN, canonical /zh, hreflang ru / zh-CN / x-default, OG locale zh_CN, индексируется', () => {
    expect(PAGE).toMatch(/<main className="ds-page" lang="zh-CN">/);
    expect(PAGE).toContain('canonical: `${SITE}/zh`');
    expect(PAGE).toMatch(/languages: \{ ru: `\$\{SITE\}\/`, 'zh-CN': `\$\{SITE\}\/zh`, 'x-default': `\$\{SITE\}\/` \}/);
    expect(PAGE).toContain("locale: 'zh_CN'");
    expect(PAGE).toContain('robots: { index: true, follow: true }');
    expect(PAGE).toContain("inLanguage: 'zh-CN'");
  });

  it('главная объявляет китайскую версию, sitemap её называет', () => {
    expect(read('app/page.tsx')).toMatch(/languages: \{ ru: '\/', 'zh-CN': '\/zh', 'x-default': '\/' \}/);
    // С 15.10 (CN-quick) sitemap берёт /zh из lib/zh/pages — того же списка,
    // что пинг IndexNow; что адрес в карте сайта есть, проверяет вызов в
    // china-quick.test.ts.
    expect(ZH_PAGE_PATHS).toContain('/zh');
  });

  it('OpenAPI несёт китайский абзац из того же источника', () => {
    const src = read('lib/api/openapi.ts');
    expect(src).toContain("import { OPENAPI_DESCRIPTION_ZH } from '@/lib/mcp/zh-layer'");
    expect(src).toMatch(/\+ ' ' \+ OPENAPI_DESCRIPTION_ZH,/);
  });

  it('все входы для агентов и команда Qwen Code — не второй копией', () => {
    for (const p of ['/api/mcp', '/.well-known/mcp.json', '/.well-known/agent-card.json', '/openapi.json', '/llms.txt']) expect(PAGE).toContain(p);
    expect(PAGE).toContain("MCP_CONNECT_OPTIONS.find((o) => o.id === 'qwen_code')");
    expect(PAGE).not.toContain('qwen mcp add');
  });
});

describe('живой каталог под гейтом витрины', () => {
  it('страница динамическая; запрос под publicTourSql со связкой с партнёром; отказ базы — null и SQLSTATE в лог', () => {
    expect(PAGE).toContain("export const dynamic = 'force-dynamic'");
    expect(ENTRY).toContain("${publicTourSql('ot')}");
    expect(ENTRY).toContain('JOIN partners p ON ot.operator_id = p.id');
    expect(ENTRY).toMatch(/console\.error\('\[zh\] каталог не прочитан:'/);
    expect(ENTRY).toMatch(/return null;/);
  });

  // «Отказ и пустота названы разными словами» — с 15.10 рендером списка
  // (components/zh/ZhTourList) в zh-quick.test.tsx.

  it('цена и длительность: единицы те же три, что у расчёта брони; нет цены — null, а не «0 卢布»', () => {
    expect(Object.keys(PRICE_UNIT_ZH).sort()).toEqual(['per_day_per_person', 'per_person', 'per_tour']);
    expect(priceZh({ base_price: '105000', price_unit: 'per_person' })).toBe('105,000 卢布 每人');
    expect(priceZh({ base_price: '60000', price_unit: 'per_tour' })).toBe('60,000 卢布 每团');
    expect(priceZh({ base_price: '0', price_unit: null })).toBeNull();
    expect(priceZh({ base_price: null, price_unit: null })).toBeNull();
    expect(durationZh({ duration_hours: '8' })).toBe('约 8 小时');
    expect(durationZh({ duration_hours: '48' })).toBe('约 2 天');
    expect(durationZh({ duration_hours: null })).toBeNull();
  });
});
