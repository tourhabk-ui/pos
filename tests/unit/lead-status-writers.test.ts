/**
 * tests/unit/lead-status-writers.test.ts
 *
 * Перепись мест, где код пишет `leads.status`.
 *
 * Статус «отменена клиентом» (`cancelled`, 1427) конечный: заявку, от которой
 * человек отказался, в работу не возвращает никто. Правило держится не одной
 * функцией, а КАЖДОЙ записью статуса — и первая редакция среза 70-1 закрыла
 * кабинет, конвейер разбора и крон добивки, пропустив четыре двери мимо них:
 * отправку предложения, кнопки статуса в рабочем чате, правку администратором
 * и квалификацию моделью. Любая из них «воскресила» бы отменённую заявку.
 *
 * Поэтому полноту держит перепись: новая запись `UPDATE leads … SET status`
 * краснеет здесь, пока автор не внёс её в реестр с ответом, что она делает с
 * отменённой заявкой. Само поведение каждой записи проверяется вызовом и на
 * настоящем PostgreSQL (tests/unit/cancelled-lead-not-revived.test.ts,
 * tests/unit/my-trip-cancel.test.ts, tests/integration/request-chat.pg.test.ts) —
 * здесь только «никто не остался снаружи».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Файл → сколько в нём записей статуса лида и что каждая делает с отменённой клиентом заявкой. */
const WRITERS: Record<string, { writes: number; cancelled: string }> = {
  'lib/requests/cancel-request.ts': { writes: 1, cancelled: 'сама отмена: единственное место, которое этот статус ставит' },
  'lib/leads/owner-lead-status.ts': { writes: 1, cancelled: 'статус и адресат не трогаются (CASE по прежнему статусу), заметку писать можно' },
  'lib/leads/status-action.ts': { writes: 1, cancelled: 'условие status <> «отменена клиентом», исход cancelled_by_client' },
  'lib/leads/proposal-delivery.ts': { writes: 2, cancelled: 'захват условный (исход lead_cancelled); откат захвата трогает только свой proposal_sent' },
  'lib/bookings/manual-booking.ts': { writes: 1, cancelled: 'условие на статус, нет строки — транзакция с бронью откатывается (lead_cancelled)' },
  'lib/services/operators/lead-processor.service.ts': { writes: 4, cancelled: 'старт и «предложение отправлено» — с условием; итог и откат трогают только свой ai_processing' },
  'lib/agents/agencies/lead-agency.ts': { writes: 1, cancelled: 'только пока заявка всё ещё new' },
  'app/api/cron/leads-followup/route.ts': { writes: 2, cancelled: 'обе записи с условием на статус; отменённую не передаёт и не эскалирует' },
  'app/api/agent/leads/[id]/route.ts': { writes: 1, cancelled: 'условие на статус, ответ 409 «отменил клиент»' },
};

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Записи статуса лида в тексте: `UPDATE leads … SET … status = …` до WHERE. */
function countLeadStatusWrites(source: string): number {
  let n = 0;
  for (const m of source.matchAll(/UPDATE\s+(?:public\.)?leads\b/g)) {
    const rest = source.slice(m.index, m.index + 1200);
    const end = rest.indexOf('`', 1);
    const sql = end > 0 ? rest.slice(0, end) : rest;
    const set = sql.split(/\bWHERE\b/)[0] ?? '';
    if (/\bstatus\s*=/.test(set)) n += 1;
  }
  return n;
}

describe('перепись записей статуса лида', () => {
  it('счётчик видит запись статуса и не путает её с записью других полей и с условием', () => {
    expect(countLeadStatusWrites('`UPDATE leads SET status = $1 WHERE id = $2`')).toBe(1);
    expect(countLeadStatusWrites('`UPDATE leads l\n   SET notes = $1,\n       status = CASE WHEN x THEN l.status ELSE $2 END\n WHERE l.id = $3`')).toBe(1);
    expect(countLeadStatusWrites('`UPDATE leads SET notes = $1 WHERE id = $2 AND status = \'new\'`')).toBe(0);
    // Другая таблица с похожим именем — не лид.
    expect(countLeadStatusWrites('`UPDATE leads_archive SET status = 1`')).toBe(0);
    expect(countLeadStatusWrites('`UPDATE public.leads SET status = $1`')).toBe(1);
    expect(countLeadStatusWrites('`UPDATE operator_bookings SET booking_status = $1`')).toBe(0);
  });

  it('каждая запись статуса лида внесена в реестр с ответом про отменённую клиентом заявку — и в реестре нет лишнего', () => {
    const found: Record<string, number> = {};
    for (const dir of ['app', 'lib', 'scripts']) {
      for (const file of walk(join(ROOT, dir))) {
        const n = countLeadStatusWrites(readFileSync(file, 'utf-8'));
        if (n > 0) found[relative(ROOT, file).split('\\').join('/')] = n;
      }
    }
    const expected = Object.fromEntries(Object.entries(WRITERS).map(([f, w]) => [f, w.writes]));
    // Новая запись статуса: ответьте в WRITERS, что она делает с заявкой, которую отменил клиент.
    expect(found).toEqual(expected);
    for (const [file, w] of Object.entries(WRITERS)) expect(w.cancelled.length, file).toBeGreaterThan(10);
  });
});
