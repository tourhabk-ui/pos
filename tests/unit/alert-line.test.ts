/**
 * Строка тревоги места и заголовок тревоги (#3607, ревью #3631): у закрытия
 * парка с опасностью из описания строка места — заголовок и опасность через
 * «: ». Читатель, ищущий тревогу по заголовку, сравнивает правилом, а не
 * равенством, иначе такое закрытие выпадает (офлайн-пакет маршрута).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alertLineIsTitle, alertLineIsTitleSql } from '@/lib/safety/alert-line';

const TITLE = 'Природный парк «Ключевской» — маршруты закрыты на зимний сезон';

describe('строка места — это тревога с таким заголовком', () => {
  it('ровно заголовок и заголовок с дописанной опасностью — да', () => {
    expect(alertLineIsTitle(TITLE, TITLE)).toBe(true);
    expect(alertLineIsTitle(`${TITLE}: передвижение в районах вулканов крайне опасно`, TITLE)).toBe(true);
  });

  it('другой заголовок с тем же началом — нет', () => {
    expect(alertLineIsTitle(`${TITLE} и в парке «Налычево»`, TITLE)).toBe(false);
    expect(alertLineIsTitle('Природный парк «Ключевской»', TITLE)).toBe(false);
  });

  it('SQL — то же правило', () => {
    expect(alertLineIsTitleSql('a', 'ea.title')).toBe("(a = ea.title OR starts_with(a, ea.title || ': '))");
  });

  it('читатели строк места не сравнивают их с заголовком равенством', () => {
    for (const file of ['app/api/routes/[id]/offline-bundle/route.ts', 'lib/services/safety/alert-prune.ts']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, file).not.toMatch(/ea\.title = ANY\(lrs\.active_alerts\)|a = ANY\(\$1::text\[\]\)/);
      expect(src, file).toContain('alertLineIsTitleSql');
    }
  });
});
