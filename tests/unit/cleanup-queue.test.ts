/**
 * Каждая запись стоит ровно в одной очереди, и очередь называет улику.
 *
 * ── Что охраняется ─────────────────────────────────────────────────────────
 *
 * «Маршрутов с проблемами: 87» — число, по которому нельзя ничего сделать.
 * За ним стоят вещи несовместимой природы: линия без подтверждённой
 * принадлежности выглядит безупречно и, вероятно, верна; запись без линии
 * вообще не о линии; точка в двадцати километрах решается уликой, а не
 * порогом. Свалить их в одну кучу «мусор» — значит либо удалить годное, либо
 * оставить опасное.
 *
 * Отсюда два требования, которые сторож и держит:
 *
 *   1. Ровно одна очередь на запись. Иначе одну и ту же беду разберут дважды
 *      и по-разному, а счёт очередей перестанет сходиться с числом записей.
 *   2. У каждой очереди — что её закрывает. Очередь без этого превращается в
 *      список претензий, по которому никто не знает, что делать.
 */
import { describe, it, expect } from 'vitest';
import { assignQueue, buildQueues, type RouteFacts } from '@/lib/routes/cleanup-queue';

const base: RouteFacts = {
  routeId: 'r1', title: 'Маршрут', hasLine: true,
  donorConfirmed: true, pathPoints: 0,
};

describe('назначение очереди', () => {
  it('линия без подтверждённой принадлежности', () => {
    expect(assignQueue({ ...base, donorConfirmed: false }).reason).toBe('donor_missing');
  });

  it('спорная точка идёт вперёд вопроса о доноре', () => {
    // Спор точки с линией разбирается раньше: пока неизвестно, врёт точка или
    // линия, устанавливать принадлежность линии не о чем.
    const q = assignQueue({ ...base, donorConfirmed: false, conflictKm: 14.2 });
    expect(q.reason).toBe('waypoint_conflict');
    expect(q.detail).toMatch(/14\.2 км/);
  });

  it('линия есть, донор подтверждён, пути нет', () => {
    expect(assignQueue(base).reason).toBe('no_path_described');
  });

  it('линии нет вовсе', () => {
    expect(assignQueue({ ...base, hasLine: false }).reason).toBe('no_line');
  });

  it('не пеший обгоняет всё: у облёта чинить нечего', () => {
    const q = assignQueue({
      ...base, notOnFoot: true, hasLine: false, donorConfirmed: false,
      conflictKm: 4.9, twinOf: 'Двойник', commercialTitle: true,
    });
    expect(q.reason).toBe('not_on_foot');
    expect(q.settledBy).toMatch(/Ничего/);
  });

  it('близнец обгоняет вопросы о линии', () => {
    // Чинить обе записи об одном объекте — делать работу дважды.
    const q = assignQueue({ ...base, twinOf: 'Вулкан Дыгерен–Оленгендэ', donorConfirmed: false });
    expect(q.reason).toBe('twin');
    expect(q.detail).toContain('Дыгерен');
  });

  it('коммерческое имя считается только при пустом пути', () => {
    expect(assignQueue({ ...base, commercialTitle: true }).reason).toBe('commercial_title');
    // Под коммерческим названием может лежать настоящий путь — тогда это не
    // вопрос рода записи, а обычный маршрут.
    expect(assignQueue({ ...base, commercialTitle: true, pathPoints: 5, donorConfirmed: false }).reason)
      .toBe('donor_missing');
  });
});

describe('очередь пригодна для работы', () => {
  it('у каждой очереди сказано, чем она закрывается', () => {
    const facts: RouteFacts[] = [
      { ...base, routeId: 'a', donorConfirmed: false },
      { ...base, routeId: 'b', conflictKm: 3 },
      { ...base, routeId: 'c' },
      { ...base, routeId: 'd', hasLine: false },
      { ...base, routeId: 'e', twinOf: 'Другой' },
      { ...base, routeId: 'f', commercialTitle: true },
      { ...base, routeId: 'g', notOnFoot: true },
    ];
    const q = buildQueues(facts);
    for (const [reason, n] of Object.entries(q.counts)) {
      if (!n) continue;
      const sample = q.samples[reason as keyof typeof q.samples][0];
      expect(sample.settledBy.length, `очередь ${reason} не говорит, чем закрывается`)
        .toBeGreaterThan(20);
    }
  });

  it('счёт очередей сходится с числом записей — никто не посчитан дважды', () => {
    const facts: RouteFacts[] = Array.from({ length: 30 }, (_, i) => ({
      ...base,
      routeId: `r${i}`,
      hasLine: i % 3 !== 0,
      donorConfirmed: i % 4 !== 0,
      conflictKm: i % 5 === 0 ? 9 : null,
      twinOf: i % 7 === 0 ? 'Близнец' : null,
      notOnFoot: i % 11 === 0,
    }));
    const q = buildQueues(facts);
    const sum = Object.values(q.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(facts.length);
    expect(q.total).toBe(facts.length);
  });

  it('очередь ничего не удаляет и не пишет', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/routes/cleanup-queue.ts'), 'utf-8');
    expect(src).not.toMatch(/DELETE|UPDATE |INSERT|pool\.query/);
  });
});
