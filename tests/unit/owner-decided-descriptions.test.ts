/**
 * Описание по решению владельца не попадает ни в одну очередь машинного
 * описания (27.09, случай Микижи). Шапка — lib/places/owner-decided.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notOwnerDecidedSql, OWNER_DECISION_WRITER } from '@/lib/places/owner-decided';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('owner-decision не переписывается машинами', () => {
  it('условие ищет запись владельца в журнале происхождения по ark_id', () => {
    const sql = notOwnerDecidedSql('p.ark_id');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('FROM description_provenance');
    expect(sql).toContain('entity_id = p.ark_id');
    expect(sql).toContain(`written_by = '${OWNER_DECISION_WRITER}'`);
  });

  it('Editor: отбор коротких описаний исключает решение владельца', () => {
    const src = read('lib/agents/editor.ts');
    const fn = src.slice(src.indexOf('export async function findRoutesNeedingDescription'));
    expect(fn.slice(0, 2500)).toContain("notOwnerDecidedSql('ark.id')");
  });

  it('enrich-places: и обычный отбор, и force исключают решение владельца', () => {
    const src = read('app/api/admin/enrich-places/route.ts');
    expect(src).toContain("notOwnerDecidedSql('p.ark_id')");
    const cond = src.slice(src.indexOf('const condition = force'), src.indexOf('const condition = force') + 400);
    expect(cond.match(/\$\{ownerKept\}/g)?.length).toBe(2);
  });

  it('миграции с решением владельца пишут ровно это имя писателя', () => {
    for (const m of ['migrations/987_klyuchevskaya_description_fact.sql', 'migrations/1034_mikizha_description_fact.sql', 'migrations/1041_mikizha_description_owner_restore.sql']) {
      expect(read(m)).toContain(`'${OWNER_DECISION_WRITER}'`);
    }
  });
});
