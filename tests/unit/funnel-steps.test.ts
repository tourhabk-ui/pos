/**
 * Именованные шаги воронки: один словарь на маяк, приёмник и срез.
 *
 * Стратегия 14.08. Главная опасность событийного слоя — расхождение имён:
 * маяк шлёт одно, приёмник ждёт другое, и событие тихо теряется (400 маяк
 * глотает по построению). Поэтому словарь ровно один — lib/funnel/steps.ts,
 * а этот сторож ловит любую попытку завести имя мимо него.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FUNNEL_STEPS, EXECUTION_STEPS, SERVER_FUNNEL_STEPS, ALL_FUNNEL_STEPS, BOOKING_REJECT_REASONS, BOOKING_REJECT_REASON_RU,
} from '@/lib/funnel/steps';
import { PUBLIC_API_ROUTES } from '@/lib/auth/public-api-routes';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('словарь один на всех', () => {
  it('маяк и приёмник берут шаги из lib/funnel/steps', () => {
    expect(read('lib/funnel/beacon.ts')).toMatch(/from '@\/lib\/funnel\/steps'/);
    const route = read('app/api/funnel/route.ts');
    expect(route).toMatch(/import \{ FUNNEL_STEPS \} from '@\/lib\/funnel\/steps'/);
    expect(route).toMatch(/z\.enum\(FUNNEL_STEPS\)/);
    // Свой список имён в приёмнике — прямой путь к тихой потере событий.
    expect(route).not.toMatch(/z\.enum\(\[/);
  });

  it('шаги стратегии присутствуют в словаре', () => {
    for (const s of [
      'booking_start', 'planner_started', 'planner_result_viewed', 'plan_saved',
      'plan_sent_to_telegram', 'partner_contact', 'mchs_registration_start',
      'offline_bundle_download',
    ]) {
      expect(FUNNEL_STEPS).toContain(s);
    }
  });

  it('действия исполнения — подмножество словаря, результат в них не входит', () => {
    for (const s of EXECUTION_STEPS) expect(FUNNEL_STEPS).toContain(s);
    expect(EXECUTION_STEPS).not.toContain('planner_result_viewed');
    expect(EXECUTION_STEPS).not.toContain('planner_started');
  });

  it('шаги сервера (#2882) маяку недоступны: их нет в FUNNEL_STEPS, они в ALL_FUNNEL_STEPS, просмотров среди них нет', () => {
    expect([...SERVER_FUNNEL_STEPS]).toEqual(['booking_submitted', 'booking_rejected']);
    for (const s of SERVER_FUNNEL_STEPS) {
      expect(FUNNEL_STEPS as readonly string[]).not.toContain(s);
      expect(ALL_FUNNEL_STEPS).toContain(s);
    }
    expect(ALL_FUNNEL_STEPS).toHaveLength(FUNNEL_STEPS.length + SERVER_FUNNEL_STEPS.length);
    expect(ALL_FUNNEL_STEPS as readonly string[]).not.toContain('tour_view');
    // Срез админки перечисляет все шаги, включая серверные.
    expect(read('app/api/admin/analytics/funnel/route.ts')).toMatch(/ALL_FUNNEL_STEPS\.map/);
  });

  it('у каждой причины отказа есть слова, ненужных слов нет', () => {
    expect(Object.keys(BOOKING_REJECT_REASON_RU).sort()).toEqual([...BOOKING_REJECT_REASONS].sort());
    for (const r of BOOKING_REJECT_REASONS) expect(BOOKING_REJECT_REASON_RU[r].length).toBeGreaterThan(3);
  });
});

describe('маяк реально долетает до приёмника', () => {
  it('/api/funnel открыт для гостей в Edge-реестре (POST)', () => {
    // Роут публичный by design (rate-limit + bot-detect внутри), но без записи
    // в PUBLIC_API_ROUTES middleware резал анонимов с 401 — маяк глотал ошибку,
    // и funnel_events был пуст для всех гостей. Нашёл сквозной прогон 14.08.
    const methods = PUBLIC_API_ROUTES['/api/funnel'];
    expect(methods).toBeDefined();
    expect(methods === 'ALL' || methods.includes('POST')).toBe(true);
  });
});

describe('события реально шлются с поверхностей', () => {
  it('планировщик: старт анкеты, результат, сохранение, контакт партнёра', () => {
    const src = read('app/planner/_PlannerClient.tsx');
    expect(src).toMatch(/funnelBeacon\('planner_started'\)/);
    expect(src).toMatch(/funnelBeacon\('planner_result_viewed'\)/);
    expect(src).toMatch(/funnelBeacon\('plan_saved'/);
    expect(src).toMatch(/funnelBeacon\('partner_contact'/);
  });

  it('страница плана: регистрация МЧС и офлайн-пакет', () => {
    const src = read('app/trip/[token]/_TripShareClient.tsx');
    expect(src).toMatch(/funnelBeacon\('mchs_registration_start'/);
    expect(src).toMatch(/funnelBeacon\('offline_bundle_download'/);
  });

  it('planner_started — один раз, с гардом', () => {
    const src = read('app/planner/_PlannerClient.tsx');
    expect(src).toMatch(/plannerStartedRef/);
  });
});

describe('NSM считается честно', () => {
  const route = read('app/api/admin/analytics/funnel/route.ts');

  it('активация = результат + действие исполнения из EXECUTION_STEPS', () => {
    expect(route).toMatch(/planner_result_viewed/);
    expect(route).toMatch(/EXECUTION_STEPS/);
  });

  it('ограничение суточного hash названо словами, а не спрятано', () => {
    // Суточный visitor_hash не сшивает дни (152-ФЗ): «уникальные за неделю»
    // были бы враньём — считаются человеко-дни, и ответ это говорит.
    expect(route).toMatch(/человеко-дни/);
    expect(route).toMatch(/window_note/);
  });

  it('нулевые шаги присутствуют в ответе — отсутствие строки не «нет шага»', () => {
    expect(route).toMatch(/FUNNEL_STEPS\.map/);
  });
});
