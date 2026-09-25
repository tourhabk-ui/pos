/**
 * Кабинет оператора говорит правду (аудит, пакет «Г», пп. 4, 5, 7–11).
 *
 * Каждая проверка держит конкретный дефект, найденный аудитом: цифру, которая
 * считала не то; кнопку, рапортовавшую несделанное; адрес, который никто не
 * пишет; дверь без проверки владельца; роут без потребителя.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
/** Код без строк-комментариев: пояснения о прежнем дефекте не считаются кодом. */
const code = (p: string) =>
  read(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('п.10: администратору партнёрская запись не заводится', () => {
  beforeEach(() => { queryMock.mockReset(); });

  function dbFor(role: string) {
    queryMock.mockImplementation((raw: unknown) => {
      const sql = String(raw);
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM users')) return Promise.resolve({ rows: [{ name: 'X', email: 'x@x.ru', role }] });
      if (sql.includes('INSERT INTO partners')) return Promise.resolve({ rows: [{ id: 'new-partner' }] });
      throw new Error('unexpected SQL: ' + sql);
    });
  }
  const inserted = () => queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO partners'));

  it('admin без записи — null и никакого INSERT', async () => {
    dbFor('admin');
    expect(await getOperatorPartnerId('admin-1')).toBeNull();
    expect(inserted()).toBe(false);
  });

  it('оператор без записи по-прежнему получает её автоматически', async () => {
    dbFor('operator');
    expect(await getOperatorPartnerId('op-1')).toBe('new-partner');
    expect(inserted()).toBe(true);
  });
});

describe('п.4: погодный алерт — свой тур и настоящий адрес', () => {
  const src = code('app/api/hub/operator/weather/route.ts');

  it('тур выбирается с проверкой владельца', () => {
    expect(src).toMatch(/getOperatorPartnerId\(authOrResponse\.userId\)/);
    expect(src).toMatch(/AND \(\$2::uuid IS NULL OR operator_id = \$2::uuid\)/);
  });

  it('адрес оператора — reachForTour, а не contacts->>telegram_chat_id', () => {
    expect(src).toMatch(/reachForTour\(/);
    expect(src).not.toMatch(/contacts->>'telegram_chat_id'/);
  });

  it('отказ отправки пишется в лог, немого catch нет', () => {
    expect(src).not.toMatch(/\.catch\(\(\) => undefined\)/);
    expect(src).toMatch(/погодный алерт по туру .* не отправлен/);
  });
});

describe('п.5: форма /operators/join', () => {
  const src = read('app/operators/join/_JoinClient.tsx');

  it('телефон и Telegram уходят в запрос регистрации', () => {
    expect(src).toMatch(/phone: form\.phone\.trim\(\) \|\| undefined/);
    expect(src).toMatch(/telegram: form\.telegram\.trim\(\) \|\| undefined/);
    // …и схема регистрации их принимает.
    const reg = read('app/api/auth/register/route.ts');
    expect(reg).toMatch(/phone: z\.string\(\)/);
    expect(reg).toMatch(/telegram: z\.string\(\)/);
  });

  it('подсказка и проверка пароля — общее правило, не «минимум 6»', () => {
    expect(src).not.toMatch(/6 символов/);
    expect(src).toMatch(/PASSWORD_RULE_HINT/);
    expect(src).toMatch(/validatePassword\(form\.password\)/);
  });
});

describe('п.7: финансы не обещают лестницу ставок', () => {
  it('подпись — назначенная ставка, число только если оно есть', () => {
    const src = read('app/hub/operator/finance/_FinancePageClient.tsx');
    expect(src).not.toMatch(/'Ставка снижается/);
    expect(src).toMatch(/Ставка назначена платформой: \$\{commissionCurrent\}%/);
    expect(src).toMatch(/const rateKnown = typeof commissionCurrent === 'number'/);
  });
});

describe('п.8: дашборд earnings', () => {
  const src = code('app/api/hub/operator/earnings/route.ts');

  it('выручка — только оплаченные и не отменённые брони', () => {
    expect(src).toMatch(/FILTER \(\s*WHERE b\.payment_status = 'paid' AND b\.booking_status <> ALL\(\$2::text\[\]\)/);
  });

  it('партнёрских кликов по source, который никто не пишет, больше нет', () => {
    expect(src).not.toMatch(/affiliate_clicks/);
    expect(src).not.toMatch(/\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/);
    const card = code('components/operator/OperatorEarningsCard.tsx');
    expect(card).not.toMatch(/Партнёрский трафик/);
    expect(card).toMatch(/Прямых продаж за \{periodDays\} дней/);
  });

  it('отказ запроса — в лог и честная ошибка, а не нули', () => {
    expect(src).toMatch(/console\.error\(`\[hub\/operator\/earnings\] сводка не прочитана/);
  });
});

describe('п.9: «Камчатская Рыбалка» не рапортует несделанный импорт', () => {
  it('кабинет оператора не показывает блок и не зовёт синхронизацию', () => {
    const src = code('app/hub/operator/integrations/_IntegrationsPageClient.tsx');
    expect(src).not.toMatch(/kamchatka-fishing/);
    expect(src).not.toMatch(/Синхронизировать/);
    expect(src).not.toMatch(/Импортировано/);
  });

  it('роут подключения — только администратору', () => {
    const src = code('app/api/partners/kamchatka-fishing/route.ts');
    expect(src).not.toMatch(/requireRole\(request, \['operator'/);
    expect(src.match(/requireRole\(request, \['admin'\]\)/g) ?? []).toHaveLength(2);
  });

  it('syncTours не считает импортом то, что не сохранено', async () => {
    const { syncTours } = await import('@/lib/partners/kamchatka-fishing/sync');
    const fakeClient = {
      getTours: async () => [{
        id: 't1', name: 'Рыбалка', description: '', price: 1, duration: 1, location: 'x',
        fishTypes: [], season: { start: '06', end: '09' }, maxParticipants: 4,
        includes: [], requirements: [], images: [], difficulty: 'easy',
      }],
    };
    const result = await syncTours(fakeClient as never);
    expect(result.toursFetched).toBe(1);
    expect(result.toursImported).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/не реализовано/);
  });
});

describe('п.11: роуты без потребителя удалены', () => {
  for (const f of [
    'app/api/hub/operator/register/route.ts',
    'app/api/operator/finance/route.ts',
    'app/api/operator/reports/revenue/route.ts',
  ]) {
    it(`${f} не возвращается`, () => {
      expect(existsSync(join(ROOT, f))).toBe(false);
    });
  }
});
