/**
 * `ignored` не считается промахом модели — ни в счёте точности, ни в
 * дайджесте «уже отвергнутого».
 *
 * PR #1373 (24.08) уже провёл эту границу один раз — в loadRejectedSignatures()
 * (стоп-лист классов претензий, tests/unit/evo-findings-closure.test.ts) — и
 * объяснил почему: `rejected` стоит дороже `ignored` ровно потому, что первое
 * идёт в счёт точности как ошибка МОДЕЛИ, а второе значит только «не
 * разбирали». Миграция 912 (тот же PR) массово закрыла ~80 непрочитанных
 * находок статусом `ignored` — и этот же день показал, что граница была
 * проведена не везде: `app/api/cron/evo-report/route.ts` (счёт точности,
 * питающий decidePublish) и `lib/agents/evo/learned-lessons.ts` (дайджест
 * «уже отвергнуто человеком» в промпте сканера) по-прежнему читали
 * `status IN ('rejected', 'ignored')`. Разовая бессудная уборка очереди
 * обрушила точность ниже PRECISION_FLOOR (0.5) и одновременно сообщила
 * сканеру, что человек лично отверг сотню классов претензий, которых
 * никто не читал, — «не разбирал» снова стало «отверг», только в двух
 * местах вместо одного.
 *
 * Эффект был измерим: до 24.08 — 10 accepted / 6 rejected из разбора
 * судьи; после миграции 912 без этой правки — тот же числитель против
 * знаменателя, раздутого ~80 записями `ignored`, точность падала далеко
 * ниже порога, и decidePublish() держал allowGuesses=false — все догадки
 * модели (growth-agent, intel) гасились, кроме одного пробника в сутки.
 *
 * Сторож читает исходники статикой (SQL не выполняется — БД тут нет),
 * тем же приёмом, что и evo-findings-closure.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8');
}

describe('счёт точности (evo-report): в rejected входит только rejected', () => {
  const src = read('app/api/cron/evo-report/route.ts');

  it('ни один COUNT FILTER для rejected не включает ignored', () => {
    const filters = [...src.matchAll(/COUNT\(\*\) FILTER \(WHERE ([^)]*rejected[^)]*)\)/g)].map((m) => m[1]);
    expect(filters.length).toBeGreaterThan(0);
    for (const f of filters) {
      expect(f, `условие "${f}" всё ещё смешивает rejected и ignored`).not.toMatch(/ignored/);
    }
  });
});

describe('петля знаний (learned-lessons): дайджест отказов — только rejected', () => {
  const src = read('lib/agents/evo/learned-lessons.ts');

  it('SQL для rejectedDigest не читает ignored', () => {
    const block = src.slice(src.indexOf('async function loadLearnedLessons'));
    expect(block).toMatch(/WHERE status = 'rejected'/);
    expect(block).not.toMatch(/status IN \('rejected', 'ignored'\)/);
  });
});
