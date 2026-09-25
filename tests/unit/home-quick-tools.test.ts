/**
 * Плитки «Планировщик» и «Радар» на главной (владелец 25.09: «планировщик
 * модной иконкой и радар модной иконкой, нужно экономить место на мобильной»).
 *
 * Сжимается вид, а не утверждение. Сторож держит:
 * 1. короткие подписи говорят то же, что полные: три состояния свежести,
 *    «не посчитано» у покрытия — своим словом, а не нулём;
 * 2. обе плитки в одном ряду и обе ведут туда же, куда вели карточки;
 * 3. полная строка приборов остаётся в aria-label — диктор читает всё.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataFreshness, freshnessShort, humanAgeShort, geometryCoverage, coverageShort,
} from '@/lib/home/data-freshness';

const HOME = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
const NOW = new Date('2026-09-25T06:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe('короткие подписи', () => {
  it('возраст коротко', () => {
    expect(humanAgeShort(0)).toBe('только что');
    expect(humanAgeShort(5)).toBe('5 мин назад');
    expect(humanAgeShort(9 * 60 + 10)).toBe('9 ч назад');
    expect(humanAgeShort(50 * 60)).toBe('2 дн назад');
  });

  it('свежесть — возраст; «свежо/устарело» несёт точка, «не знаем» — словами', () => {
    expect(freshnessShort(dataFreshness({ updatedAt: ago(20), source: 'safety', now: NOW }))).toBe('20 мин назад');
    expect(freshnessShort(dataFreshness({ updatedAt: ago(9 * 60), source: 'safety', now: NOW }))).toBe('9 ч назад');
    expect(freshnessShort(dataFreshness({ updatedAt: null, now: NOW }))).toBe('нет данных');
  });

  it('покрытие: процент с положительного конца; «не посчитано» — не 0%', () => {
    expect(coverageShort(geometryCoverage({ total: 392, withoutTrack: 102 }))).toBe('офлайн 74%');
    expect(coverageShort(geometryCoverage({ total: null, withoutTrack: null }))).toBe('офлайн: н/д');
    expect(coverageShort(geometryCoverage({ total: 0, withoutTrack: 0 }))).toBe('офлайн: н/д');
  });

  it('короткие подписи не длиннее 16 знаков — столько входит в плитку на 360px', () => {
    const samples = [
      freshnessShort(dataFreshness({ updatedAt: ago(59), now: NOW })),
      freshnessShort(dataFreshness({ updatedAt: ago(23 * 60), now: NOW })),
      freshnessShort(dataFreshness({ updatedAt: ago(40 * 24 * 60), now: NOW })),
      coverageShort(geometryCoverage({ total: 10, withoutTrack: 0 })),
      coverageShort(geometryCoverage({ total: null, withoutTrack: null })),
    ];
    for (const t of samples) expect(t.length, t).toBeLessThanOrEqual(16);
  });
});

describe('плитки на главной', () => {
  const tools = HOME.slice(HOME.indexOf('<nav className="qtools"'), HOME.indexOf('</nav>', HOME.indexOf('<nav className="qtools"')));

  it('один ряд из двух плиток вместо двух полноширинных карточек', () => {
    expect(tools).not.toBe('');
    expect(HOME).toMatch(/\.v7 \.qtools\{[^}]*grid-template-columns:1fr 1fr/);
    expect(HOME).not.toMatch(/className="planline"|<section className="live">/);
  });

  it('ведут туда же: планировщик — /planner, радар — /safety#radar', () => {
    expect(tools).toMatch(/href="\/planner" className="qt qt-plan"/);
    expect(tools).toMatch(/href="\/safety#radar"\s+className="qt qt-radar"/);
  });

  it('полная строка приборов — в aria-label радара, а не только сокращение', () => {
    expect(tools).toContain('aria-label={`Радар обстановки. ${fresh.label}. ${coverage.label}`}');
  });

  it('иконки — lucide, без эмодзи', () => {
    expect(tools).toContain('<CalendarDays');
    expect(tools).toContain('<Radar');
    expect(tools).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('чипы интересов — один ряд (владелец 25.09: «занимают 2 строчки, не экономно»)', () => {
  it('сетка на столько колонок, сколько чипов, без переноса', async () => {
    const { INTENT_CHIPS } = await import('@/lib/home/intent-chips');
    const rule = /\.v7 \.hero-chips\{([^}]*)\}/.exec(HOME)?.[1] ?? '';
    expect(rule).toContain(`grid-template-columns:repeat(${INTENT_CHIPS.length},minmax(0,1fr))`);
    expect(rule).not.toMatch(/flex-wrap:wrap/);
  });

  it('подпись в одну строку, зона нажатия не меньше 44px', () => {
    expect(HOME).toMatch(/\.v7 \.hchip\{[^}]*min-height:56px/);
    expect(HOME).toMatch(/\.v7 \.hchip \.hc-l\{[^}]*white-space:nowrap/);
    expect(HOME).toContain('<span className="hc-l">{c.label}</span>');
  });
});

describe('полевые инструменты — сеткой 2×2 (владелец 25.09: «место жалко на главной»)', () => {
  const at = HOME.indexOf('<nav className="qtools stools"');
  const grid = at === -1 ? '' : HOME.slice(at, HOME.indexOf('</nav>', at));

  it('четыре плитки в секции #radar, а не четыре полноширинные строки', () => {
    expect(grid).not.toBe('');
    expect((grid.match(/className="qt(?: mchsline)?"/g) ?? []).length).toBe(4);
    expect(HOME).not.toMatch(/className="protoline|className="reportbtn/);
    const radar = HOME.slice(HOME.indexOf('id="radar"'), HOME.indexOf('</section>', HOME.indexOf('id="radar"')));
    expect(radar).toContain('<nav className="qtools stools"');
  });

  it('навигатор и наблюдение — жёсткие ссылки <a> (офлайн грузит закэшированную страницу)', () => {
    expect(grid).toMatch(/<a\s+href="\/planning\?mode=trail"/);
    expect(grid).toMatch(/<a\s+href="\/planning\?mode=trail&obs=1"/);
  });

  it('полная фраза каждой плитки — в aria-label, короткая подпись не длиннее 16 знаков', () => {
    expect((grid.match(/aria-label="[^"]{20,}"/g) ?? []).length).toBe(4);
    const captions = [...grid.matchAll(/<b>[^<]+<\/b><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(captions).toHaveLength(4);
    for (const c of captions) expect(c.length, c).toBeLessThanOrEqual(16);
  });
});

describe('поиск без отдельной кнопки «Найти» (владелец 25.09: «дублирует переход»)', () => {
  const form = HOME.match(/<form className="find"[\s\S]*?<\/form>/)?.[0] ?? '';

  it('отправка — лупой-кнопкой и клавишей клавиатуры, большой кнопки нет', () => {
    expect(form).toMatch(/<button type="submit" className="find-go" aria-label="Найти">\s*<Search/);
    expect(form).not.toMatch(/>Найти<\/button>/);
    expect(form).toContain('enterKeyHint="search"');
    expect((form.match(/<button/g) ?? []).length).toBe(1);
  });

  it('лупа — полноценная зона нажатия 44px', () => {
    expect(HOME).toMatch(/\.v7 \.find \.find-go\{[^}]*width:44px;min-height:44px/);
  });
});

