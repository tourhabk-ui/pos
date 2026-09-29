/**
 * Сторож: перепись правил цены только считает и умеет сказать «не смог».
 *
 * ── Зачем перепись ────────────────────────────────────────────────────────
 *
 * Владелец 27.09 попросил дать местному туристу скидки. Движок скидок в
 * платформе уже есть (`tour_pricing_rules` + `calculateDynamicPrice`), но на
 * нашем сайте цена показывается мимо него: `/api/tours/[id]/price` не зовётся
 * ни с одной страницы, а `bulkDynamicPrices` зовётся из
 * `/api/octo/availability` — то есть динамическую цену получает ЧУЖОЙ канал.
 *
 * Подключить показ, не зная числа активных правил, значило бы обещать скидку
 * без источника (§10.09): экран бы появился, а цифра на нём осталась бы
 * прежней. Поэтому сначала число.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Перепись — свидетель, и испортить её можно двумя способами: заставить
 * писать в базу (тогда она перестанет быть безопасной для прогона на проде) и
 * позволить ей отвечать нулём на упавший запрос (тогда «скидок нет» будет
 * неотличимо от «не посчитали», а по этому выводу принимается решение).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFINITIONS } from '@/app/api/cron/pricing-rules-census/route';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const ROUTE = readFileSync(
  join(process.cwd(), 'app/api/cron/pricing-rules-census/route.ts'),
  'utf-8',
);

describe('перепись только читает', () => {
  it('ни UPDATE, ни INSERT, ни DELETE в запросах', () => {
    // Безопасность прогона на проде здесь — свойство кода, а не обещание в
    // шапке: перепись зовут рукой по адресу, и она не должна менять данные.
    const sql = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(sql).not.toMatch(/\bUPDATE\s+\w/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('род объявлен: ручная, не пишет', () => {
    const d = MANUAL_ENDPOINTS['pricing-rules-census'];
    expect(d, 'перепись не объявлена в cron-schedulers').toBeTruthy();
    expect(d.writes).toBe(false);
    expect(d.note.length, 'причина не названа').toBeGreaterThan(80);
  });

  it('закрыта секретом крона', () => {
    expect(ROUTE).toMatch(/timingSafeCompare\(getCronSecret\(request\), cronSecret\)/);
  });
});

describe('ноль отличим от «не смог»', () => {
  it('каждое число допускает отсутствие', () => {
    // `number` вместо `number | null` принуждает вернуть 0 на упавшем
    // запросе — ровно та подмена третьего исхода первым, от которой §4.0.
    const iface = ROUTE.slice(ROUTE.indexOf('export interface PricingRulesCensus'), ROUTE.indexOf('export const DEFINITIONS'));
    const numbers = iface.match(/^\s{2}\w+:.*$/gm) ?? [];
    const counted = numbers.filter((l) => /number|Record<string, number>/.test(l));
    expect(counted.length, 'в ответе нет ни одного числа').toBeGreaterThan(5);
    for (const line of counted) {
      expect(line, `${line.trim()}: отсутствие не допускается`).toMatch(/\| null/);
    }
  });

  it('отказ запроса попадает и в лог, и в ответ', () => {
    expect(ROUTE).toMatch(/console\.error\(`\[pricing-rules-census\]/);
    expect(ROUTE).toMatch(/errors\.push\(/);
    expect(ROUTE).toMatch(/SQLSTATE/);
  });
});

describe('определения даются читателю, а не остаются в голове автора', () => {
  it('у каждого числа ответа есть определение', () => {
    for (const key of [
      'rules_active', 'rules_by_type', 'tours_with_rules', 'tours_living',
      'discount_rules', 'surcharge_rules', 'neutral_rules',
      'price_overrides', 'price_old_filled',
    ]) {
      expect(DEFINITIONS[key], `${key}: нет определения`).toBeTruthy();
    }
  });

  it('скидка и надбавка считаются раздельно', () => {
    // Сложить их в одно число значило бы выдать сурдж за выгоду туристу.
    expect(DEFINITIONS.discount_rules).toMatch(/multiplier < 1/);
    expect(DEFINITIONS.surcharge_rules).toMatch(/multiplier > 1/);
    expect(ROUTE).toMatch(/multiplier < 1/);
    expect(ROUTE).toMatch(/multiplier > 1/);
  });

  it('рукописная «скидка» price_old считается отдельно от правил', () => {
    // Сегодня это единственное, что видит турист, и путать её с движком
    // правил нельзя: одна набрана руками оператора, другая считается.
    expect(DEFINITIONS.price_old_filled).toMatch(/price_old/);
  });
});
