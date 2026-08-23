/**
 * Чистка неисполнимых записей очереди эволюции.
 *
 * Замер 23.08: 21 запись `pending` висела с апреля. Их действие
 * `auto_fix_dead_code` с телом `DELETE FILE: …` в коде не встречается ни разу —
 * подсистема, которая их создавала, удалена. Рука эволюции пропускает их
 * каждый прогон, и они остаются «ожидающими» навсегда. Панель показывает
 * работу, которой никто не сделает, а настоящая ожидающая правка тонет.
 *
 * Главное свойство, которое здесь сторожится: чистка судит записи ТЕМ ЖЕ
 * предикатом, что и рука. Свой список «плохих действий» разошёлся бы с рукой,
 * и чистка начала бы убирать то, что рука ещё умеет применять.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFixPayload } from '@/lib/agents/evo/deterministic-fix';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/evo-log-cleanup/route.ts'), 'utf-8');
/** Только код: в шапке роут ЗАКОННО называет мёртвое действие по имени. */
const CODE = ROUTE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('предикат общий с рукой эволюции', () => {
  it('чистка зовёт parseFixPayload, а не свой список действий', () => {
    expect(ROUTE).toMatch(/import \{ parseFixPayload \}/);
    expect(ROUTE).toMatch(/parseFixPayload\(r\.diff_summary\) === null/);
  });

  it('своего перечня «плохих» действий в чистке нет', () => {
    // Появление такого списка означает вторую копию правила — она разойдётся.
    expect(CODE, 'в чистке завёлся свой список действий')
      .not.toMatch(/auto_fix_dead_code|'delete_file'|DEAD_ACTIONS/);
  });

  it('запись из мёртвой подсистемы предикат действительно отбраковывает', () => {
    expect(parseFixPayload('DELETE FILE: lib/analytics/lead-tracking.ts')).toBeNull();
    expect(parseFixPayload(null)).toBeNull();
  });

  it('исполнимую запись предикат пропускает — чистка её не тронет', () => {
    // Отрицательный контроль: чистка, убирающая всё подряд, хуже её отсутствия.
    const live = JSON.stringify({ kind: 'add_index', table: 'operator_bookings', column: 'created_at' });
    expect(parseFixPayload(live)).not.toBeNull();
  });
});

describe('правка данных ведёт себя как правка данных', () => {
  it('сухой прогон по умолчанию', () => {
    expect(ROUTE).toMatch(/apply\s*=\s*url\.searchParams\.get\('apply'\) === '1'/);
    expect(ROUTE).toMatch(/dry_run: true/);
  });

  it('партия ограничена потолком', () => {
    expect(ROUTE).toMatch(/MAX_BATCH/);
    expect(ROUTE).toMatch(/Math\.min\(/);
  });

  it('запись не исчезает, а получает причину', () => {
    expect(ROUTE).toMatch(/status = 'stale'/);
    expect(ROUTE).toMatch(/review_notes/);
    expect(ROUTE, 'чистка удаляет строки вместо пометки').not.toMatch(/DELETE\s+FROM\s+evo_evolution_log/i);
  });

  it('отказ БД — третий исход, а не «мусора нет»', () => {
    expect(ROUTE).toMatch(/SQLSTATE/);
    expect(ROUTE).toMatch(/status: 503/);
    expect(ROUTE, 'вернулся глухой catch').not.toMatch(/catch \{\s*\}/);
  });

  it('доступ закрыт cron-секретом', () => {
    expect(ROUTE).toMatch(/verifyCronSecret\(req\)/);
  });
});
