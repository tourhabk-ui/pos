/**
 * tests/unit/intel-html-is-not-answer.test.ts
 *
 * Лента, отдавшая HTML, — отказ источника, а не «ответила и пуста».
 *
 * ── Что случилось (08.09) ──────────────────────────────────────────────────
 *
 * Watchdog по домену competitors: «1 из 1 лент ответили и пусты:
 * kamchatka.aif.ru: HTTP 200, 9 КБ, HTML вместо ленты». Вердикт прогона —
 * `no_signals`, а он объявлен как «источники ЖИВЫ, новостей НЕТ».
 *
 * То есть единственная лента домена мертва, а владельцу приходила спокойная
 * сводка о рынке. Разница не косметическая: у `no_signals` чинить нечего, а
 * `gather_failed` с именем ленты говорит, что источник пора менять.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Границу между двумя пустотами. Живая лента без новостей — законная тишина и
 * остаётся ответом; тело, которое лентой не является, ответом не считается.
 * Приравнять их — та же подмена «не смог» на «всё хорошо», что и весь §4.0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeEmptyGather, classifyFeedBody, describeFeedBody } from '@/lib/agents/intel-gather-census';

const SRC = readFileSync(join(process.cwd(), 'lib/services/intelligence-monitor.service.ts'), 'utf-8');

describe('тело не-ленты идёт в отказ, а не в ответ', () => {
  it('сбор помечает такую ленту отказом', () => {
    // Проверяется поставляемый код: без этой ветки census.answered растёт на
    // мёртвой ленте, и вердикт внизу физически не может стать gather_failed.
    expect(SRC).toMatch(/const notAFeed = feed\.items\.length === 0 && feed\.kind !== 'rss' && feed\.kind !== 'atom'/);
    expect(SRC).toMatch(/if \(notAFeed\) return \{ ok: false/);
  });

  it('живая, но пустая лента ответом остаётся', () => {
    // Ключевая граница: RSS без записей — это законная тишина. Записать её в
    // отказ значило бы завести ложную тревогу вместо снятой.
    const kind = classifyFeedBody('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>');
    expect(kind).toBe('rss');
    expect(SRC).toMatch(/feed\.kind !== 'rss'/);
  });
});

describe('вердикт по переписи различает мёртвую ленту и тихий рынок', () => {
  it('единственная лента отдала HTML — gather_failed с её именем', () => {
    const reason = describeFeedBody('kamchatka.aif.ru', 200, 9216, 'html');
    const v = judgeEmptyGather({ attempted: 1, answered: 0, failed: 1, failures: [reason], empties: [] });
    expect(v.outcome).toBe('gather_failed');
    expect(v.reason).toMatch(/kamchatka\.aif\.ru/);
    expect(v.reason).toMatch(/HTML вместо ленты/);
  });

  it('лента ответила и правда пуста — no_signals', () => {
    const v = judgeEmptyGather({ attempted: 1, answered: 1, failed: 0, failures: [], empties: ['x: RSS без записей'] });
    expect(v.outcome).toBe('no_signals');
  });

  it('лент не настроено вовсе — тоже не «новостей нет»', () => {
    const v = judgeEmptyGather({ attempted: 0, answered: 0, failed: 0, failures: [], empties: [] });
    expect(v.outcome).toBe('gather_failed');
  });
});

describe('распознавание тела ленты', () => {
  it('HTML не принимается за ленту', () => {
    expect(classifyFeedBody('<!doctype html><html><body>страница</body></html>')).toBe('html');
  });

  it('Atom распознаётся', () => {
    expect(classifyFeedBody('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toBe('atom');
  });

  it('пустое тело названо своим словом', () => {
    expect(classifyFeedBody('   ')).toBe('empty');
  });
});
