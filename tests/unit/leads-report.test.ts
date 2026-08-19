/**
 * Рост-5: партнёрский отчёт по лидам — «сколько пришло, откуда, что стало».
 *
 * Три опасности, которые держит сторож:
 *  1. Канал лида считается в двух местах и расходится — нормализатор ровно
 *     один (lib/leads/channel.ts), createLead пишет его при создании.
 *  2. Нечестная атрибуция: приписать партнёру лид по случайному матчу туров
 *     (lead-processor подбирает ORDER BY RANDOM с fallback на любые туры).
 *     Оператор назначается только детерминированно.
 *  3. ПД туристов в отчёте: партнёру нужны счётчики, не телефоны.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_CHANNELS, normalizeLeadChannel } from '@/lib/leads/channel';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const CREATE = read('lib/leads/create.ts');
const REPORT = read('app/api/hub/operator/leads/report/route.ts');
const MIGRATION = read('migrations/860_leads_source_channel.sql');

describe('канал лида: один нормализатор', () => {
  it('распознаёт фактические сигнатуры точек входа', () => {
    // Сигнатуры — из реальных вызовов createLead (mcp, telegram, max, widget,
    // booking-intake, форма сайта). Меняется вызывающий — меняется и этот тест.
    expect(normalizeLeadChannel({ source_url: 'mcp://vedar/booking', source_data: { source: 'mcp' } })).toBe('mcp');
    expect(normalizeLeadChannel({ source_url: 'https://t.me/kuzmichai_bot' })).toBe('telegram');
    expect(normalizeLeadChannel({ telegram_chat_id: '42' })).toBe('telegram');
    expect(normalizeLeadChannel({ source_url: 'https://max.ru', source_data: { source: 'max_bot' } })).toBe('max');
    expect(normalizeLeadChannel({ source_url: 'https://partner.ru', source_data: { type: 'widget' } })).toBe('widget');
    expect(normalizeLeadChannel({ source_url: '/api/ai/booking-intake', source_data: { source: 'booking_intake_bot' } })).toBe('site_chat');
    expect(normalizeLeadChannel({ source_url: 'https://vedarai.ru/routes/abc' })).toBe('site_route');
    expect(normalizeLeadChannel({ source_url: 'https://vedarai.ru/catalog/tours/1' })).toBe('site_tour');
    expect(normalizeLeadChannel({ source_url: 'https://vedarai.ru/planner' })).toBe('site_planner');
    expect(normalizeLeadChannel({ source_url: 'https://vedarai.ru/' })).toBe('site');
    expect(normalizeLeadChannel({})).toBe('other');
  });

  it('каждый ответ нормализатора — из словаря LEAD_CHANNELS', () => {
    const outs = [
      normalizeLeadChannel({}),
      normalizeLeadChannel({ source_url: 'https://vedarai.ru/routes/x' }),
      normalizeLeadChannel({ telegram_chat_id: '1' }),
    ];
    for (const o of outs) expect(LEAD_CHANNELS).toContain(o);
  });

  it('createLead пишет source_channel через нормализатор, не свою логику', () => {
    expect(CREATE).toMatch(/normalizeLeadChannel\(\{ source_url, source_data, telegram_chat_id \}\)/);
    expect(CREATE).toMatch(/source_channel/);
  });

  it('миграция 860 — колонка и индекс идемпотентны', () => {
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS source_channel/);
    expect(MIGRATION).toMatch(/CREATE INDEX IF NOT EXISTS idx_leads_source_channel/);
  });
});

describe('атрибуция оператора — только детерминированная', () => {
  it('назначение по маршруту требует ровно одного владельца туров', () => {
    // LIMIT 2 + проверка length === 1: два оператора на маршруте — лид ничей.
    expect(CREATE).toMatch(/DISTINCT operator_id FROM operator_tours/);
    expect(CREATE).toMatch(/LIMIT 2/);
    expect(CREATE).toMatch(/owners\.rows\.length === 1/);
  });

  it('случайный матч lead-processor атрибуцией не является', () => {
    // Комментарий-предупреждение обязан жить рядом с кодом атрибуции.
    expect(CREATE).toMatch(/RANDOM/);
  });
});

describe('отчёт партнёру: счётчики без ПД', () => {
  it('в SQL отчёта нет персональных полей лида', () => {
    for (const col of ['name', 'phone', 'email', 'comment']) {
      expect(REPORT).not.toMatch(new RegExp(`SELECT[^;]*\\b${col}\\b`, 'i'));
    }
    expect(REPORT).toMatch(/COUNT\(\*\)/);
  });

  it('скоуп: оператор — только свой partner.id, админ — явный operator_id', () => {
    expect(REPORT).toMatch(/requireOperator\(request\)/);
    expect(REPORT).toMatch(/SELECT id FROM partners WHERE user_id = \$1/);
    expect(REPORT).toMatch(/operator_id = \$1/);
    expect(REPORT).toMatch(/user\.role === 'admin'/);
  });

  it('общий пул ничейных — отдельное число, не в счётчиках партнёра', () => {
    expect(REPORT).toMatch(/operator_id IS NULL/);
    expect(REPORT).toMatch(/unassigned_pool_30d/);
    expect(REPORT).toMatch(/attribution_note/);
  });
});
