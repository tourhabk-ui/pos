/**
 * Каталог моделей с ценами: прод его не спрашивает, «нет цены» не равно нулю,
 * пустая партия — отказ.
 *
 * ── Чем это оплачено ───────────────────────────────────────────────────────
 *
 * Владелец 09.09 попросил актуальные цены в админке и переключение моделей на
 * проде. Прод при этом OpenRouter НЕ ВИДИТ — 403 и напрямую, и через релей
 * (замер 07.09), — поэтому цены везёт раннер, а прод только записывает. Если
 * однажды кто-то «упростит» это прямым запросом с прода, страница замолчит и
 * будет показывать вчерашние цены как сегодняшние.
 *
 * Второе: у цены три состояния, и склеить их дёшево. Каталог может не назвать
 * цену вовсе, может назвать ноль (у бесплатных моделей это правда), а разбор
 * может не справиться. Ноль вместо «не знаю» на экране выбора модели читается
 * как «бесплатно» — и ровно так и будет понят.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCatalogPrice,
  vendorOf,
  workloadCostUsd,
  workloadMonthlyUsd,
  workloadByKey,
  WORKLOADS,
} from '@/lib/ai/model-cost';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('цена из каталога: три состояния', () => {
  it('строка за токен превращается в цену за миллион', () => {
    // Каталог отдаёт «0.0000014» за ОДИН токен — это $1.4 за миллион.
    expect(parseCatalogPrice('0.0000014')).toBeCloseTo(1.4, 6);
    expect(parseCatalogPrice('0.000005')).toBeCloseTo(5, 6);
    expect(parseCatalogPrice(0.00001)).toBeCloseTo(10, 6);
  });

  it('ноль — это ноль, а не «не знаем»', () => {
    // У бесплатных моделей каталог пишет «0», и это факт, а не пробел.
    expect(parseCatalogPrice('0')).toBe(0);
  });

  it('нет числа — null, и это НЕ ноль', () => {
    for (const bad of [undefined, null, '', '   ', 'бесплатно', {}, []]) {
      expect(parseCatalogPrice(bad), String(bad)).toBeNull();
    }
  });

  it('вендор берётся из слага', () => {
    expect(vendorOf('z-ai/glm-5.3')).toBe('z-ai');
    expect(vendorOf('anthropic/claude-opus-5')).toBe('anthropic');
    expect(vendorOf('glm-5.1')).toBe('glm-5.1');
  });
});

describe('счёт за нашу работу', () => {
  const judge = workloadByKey('judge');

  it('считается по форме работы, а не по одному числу прайса', () => {
    // GLM 5.3 и Opus 5 — настоящие цены из каталога 09.09.
    const glm = workloadCostUsd({ usdPerMTokIn: 1.4, usdPerMTokOut: 4.4 }, judge);
    const opus = workloadCostUsd({ usdPerMTokIn: 5, usdPerMTokOut: 25 }, judge);
    expect(glm).toBeCloseTo(0.81, 2);
    expect(opus).toBeCloseTo(3.13, 2);
  });

  it('неизвестная цена даёт null, а не ноль', () => {
    // Ноль в колонке «за прогон» читается как «бесплатно» и решает выбор.
    expect(workloadCostUsd({ usdPerMTokIn: null, usdPerMTokOut: 4.4 }, judge)).toBeNull();
    expect(workloadCostUsd({ usdPerMTokIn: 1.4, usdPerMTokOut: null }, judge)).toBeNull();
    expect(workloadMonthlyUsd({ usdPerMTokIn: null, usdPerMTokOut: null }, judge)).toBeNull();
  });

  it('у каждой формы названо, откуда взяты числа', () => {
    // Оценку можно оспорить только тогда, когда видно её основание.
    for (const w of WORKLOADS) {
      expect(w.basis.length, w.key).toBeGreaterThan(30);
      expect(w.calls).toBeGreaterThan(0);
    }
  });
});

describe('прод наружу не ходит', () => {
  it('ни приём каталога, ни админская выдача не зовут openrouter.ai', () => {
    // Прод получает оттуда 403; «упрощение» прямым запросом означало бы
    // молчаливо пустую страницу вместо привезённых цен.
    for (const p of ['app/api/cron/model-catalog/route.ts', 'app/api/admin/model-catalog/route.ts']) {
      expect(read(p), p).not.toContain('openrouter.ai');
    }
    // А раннер — ходит, в этом его смысл.
    expect(read('scripts/model-catalog-runner.ts')).toContain('openrouter.ai/api/v1/models');
  });

  it('прогон только читает каталог — ни одного запроса к модели', () => {
    const src = read('scripts/model-catalog-runner.ts');
    expect(src).not.toContain('chat/completions');
  });
});

describe('пустая партия — отказ, а не пустой каталог', () => {
  it('роут отказывается записывать ноль моделей', () => {
    const src = read('app/api/cron/model-catalog/route.ts');
    expect(src).toMatch(/models\.length === 0/);
    expect(src).toContain('это отказ прогона, а не пустой каталог');
  });

  it('прогон краснеет на нулевом каталоге', () => {
    // Иначе в журнале Actions отказ выглядит успехом.
    expect(read('scripts/model-catalog-runner.ts')).toContain('это отказ, а не пустой каталог');
  });

  it('партия пишется транзакцией и отказ идёт в лог', () => {
    const src = read('app/api/cron/model-catalog/route.ts');
    expect(src).toContain('BEGIN');
    expect(src).toContain('ROLLBACK');
    // Молчаливый откат выглядит как «цены не менялись».
    expect(src).toMatch(/console\.error\('\[model-catalog\]/);
  });
});

describe('свежесть названа словами', () => {
  const src = read('app/api/admin/model-catalog/route.ts');

  it('три состояния: не приезжал / устарел / свежий', () => {
    expect(src).toContain("'never'");
    expect(src).toContain("'stale'");
    expect(src).toContain("'fresh'");
  });

  it('пустая таблица объясняется, а не показывается пустым экраном', () => {
    expect(src).toContain('Каталог ни разу не приезжал');
  });

  it('выбывшая из каталога модель помечена', () => {
    // Иначе её вчерашняя цена стоит в таблице наравне с сегодняшними.
    expect(src).toContain('in_latest_batch');
  });

  it('оценка объёма названа оценкой', () => {
    expect(src).toContain('estimated: true');
    expect(read('app/hub/admin/ai-usage/_ModelCatalogClient.tsx')).toContain('по ОЦЕНКЕ объёма, а не по замеру');
  });
});
