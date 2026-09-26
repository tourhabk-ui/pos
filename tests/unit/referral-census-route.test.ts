/**
 * Перепись агентских реферальных ссылок только ЧИТАЕТ.
 *
 * ── Почему сторож структурный, а не поведенческий ─────────────────────────
 *
 * Тот же приём, что у `places-osm-crosscheck-route`: обещание «роут не
 * пишет» проверяется по ИСХОДНИКУ, а не прогоном. Прогон доказывает, что при
 * данных аргументах записи не случилось; исходник — что записи нет ни при
 * каких. Для переписи, которая смотрит на денежный путь, нужна вторая
 * гарантия: пишущий шаг, добавленный сюда по недосмотру, тронул бы ставки
 * агентов.
 *
 * ── Что ещё держится ──────────────────────────────────────────────────────
 *
 * 1. Ставка NULL не приводится ни к нулю, ни к десяти. «Процента нет» и
 *    «процент ноль» — разные состояния (§4.0), и в деньгах разница между
 *    ними в целую выплату. COALESCE по `commission_rate` здесь запрещён.
 * 2. Сумма обещанного считается ТЕМ ЖЕ выражением, что показывает кабинет
 *    агента. Перепись, считающая по-своему, меряет не то, что видит человек,
 *    и расхождение спишут на перепись.
 * 3. Персональных данных агента наружу нет: ответ уходит в лог GitHub
 *    Actions, а имя и контакты — персональные данные (152-ФЗ).
 * 4. Род роута объявлен в реестре планировщиков — иначе он красный у
 *    `cron-scheduler-declared`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANUAL_ENDPOINTS, DECLARED } from '@/lib/agents/cron-schedulers';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/cron/referral-census/route.ts'), 'utf-8');
const CABINET = readFileSync(join(ROOT, 'app/api/hub/agent/referral/route.ts'), 'utf-8');

/** Строки кода без комментариев: в шапке слова вроде UPDATE стоят по делу. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const at = l.indexOf('//');
      return at === -1 ? l : l.slice(0, at);
    })
    .join('\n');
}

describe('перепись только читает', () => {
  const code = codeOnly(ROUTE);

  it('в коде нет ни одного пишущего выражения', () => {
    for (const verb of ['UPDATE ', 'INSERT ', 'DELETE ', 'TRUNCATE', 'ALTER ']) {
      expect(code, `найдено ${verb.trim()}`).not.toMatch(new RegExp(`\\b${verb.trim()}\\b`, 'i'));
    }
  });

  it('экспортирован только GET', () => {
    expect(ROUTE).toMatch(/export async function GET\(/);
    expect(ROUTE).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\(/);
  });

  it('закрыт CRON_SECRET, как остальные переписи', () => {
    expect(ROUTE).toMatch(/getCronSecret/);
    expect(ROUTE).toMatch(/timingSafeCompare/);
  });
});

describe('ставка «не назначена» — не ноль', () => {
  const code = codeOnly(ROUTE);

  it('commission_rate нигде не подменяется умолчанием', () => {
    // COALESCE(commission_rate, 10) превратил бы «ставки нет» в «ставка
    // десять» — молча и в деньгах.
    expect(code).not.toMatch(/COALESCE\s*\(\s*(rl\.)?commission_rate/i);
    expect(code).not.toMatch(/commission_rate\s*,\s*(0|10)\s*\)/i);
  });

  it('пустая ставка считается отдельным счётчиком и называется словами', () => {
    expect(code).toMatch(/commission_rate IS NULL/i);
    expect(ROUTE).toMatch(/rate_unset/);
    expect(ROUTE).toMatch(/ставка не назначена/);
  });

  it('null доезжает до ответа как null, а не как число', () => {
    expect(ROUTE).toMatch(/r\.rate === null \? null : Number\(r\.rate\)/);
  });
});

describe('обещанная сумма считается тем же, чем её показывают', () => {
  it('выражение переписи повторяет правило денег агента', () => {
    // С 26.09 кабинет считает деньги единственной функцией денег агента:
    // ставка АГЕНТА, только оплаченные и не отменённые. Перепись обязана
    // мерить то же, а не прежнее «ставка ссылки × все оплаченные».
    expect(CABINET).toMatch(/loadAgentMoney\(pool, auth\.userId\)/);
    const code = codeOnly(ROUTE);
    expect(code).toMatch(/final_price \* p\.agent_commission_rate \/ 100/);
    expect(code).toMatch(/NOT \(ob\.booking_status = ANY\(\$1::text\[\]\)\)/);
    expect(code).toMatch(/CANCELLED_STATUS_PARAM/);
  });

  it('обещанное считается только по ОПЛАЧЕННЫМ броням', () => {
    const code = codeOnly(ROUTE);
    expect(code).toMatch(/promised_total/);
    expect(code).toMatch(/payment_status\s*=\s*'paid'/);
  });

  it('обещание названо обещанием, а не долгом', () => {
    expect(ROUTE).toMatch(/обещание, а не долг/);
  });
});

describe('персональных данных агента в ответе нет', () => {
  const code = codeOnly(ROUTE);

  it('ни имени, ни почты, ни телефона агента не выбирается', () => {
    for (const col of ['\\bu\\.name', '\\bemail', '\\bphone', 'tourist_name', 'tourist_email']) {
      expect(code, `в выборке ${col}`).not.toMatch(new RegExp(col, 'i'));
    }
  });

  it('агент виден числом, а в списке — только кодом ссылки', () => {
    expect(ROUTE).toMatch(/COUNT\(DISTINCT agent_id\)/);
    expect(ROUTE).toMatch(/\$\{r\.code\}/);
  });
});

describe('род роута объявлен', () => {
  it('перепись числится ручной и непишущей в реестре планировщиков', () => {
    // Роут под /api/cron/ без workflow и без объявления — красный у
    // cron-scheduler-declared. Объявление здесь же проверяется по существу:
    // перепись не должна числиться пишущей.
    const decl = MANUAL_ENDPOINTS['referral-census'];
    expect(decl, 'referral-census не объявлен в cron-schedulers').toBeTruthy();
    expect(decl.kind).toBe('manual');
    expect(decl.writes).toBe(false);
    expect(decl.note.length).toBeGreaterThan(40);
    // И в общем реестре — иначе cron-scheduler-declared считает роут молчащим.
    expect(DECLARED['referral-census']).toBeTruthy();
  });
});
