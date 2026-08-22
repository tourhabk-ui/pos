/**
 * Сторож: у каждого эндпоинта под /api/cron/ есть названный запускающий.
 *
 * Перепись достижимости 22.08: 122 роута, из них 74 дёргаются из
 * .github/workflows, а 44 — ничем, что видно из репозитория. Внутри этих 44
 * лежали рядом две несовместимые вещи: ручные переписи, у которых расписания и
 * не должно быть, и джобы, чья собственная шапка обещает расписание снаружи —
 * включая `payouts`, релиз удержанных платежей оператору. По имени каталога
 * они неотличимы, и «сломанное расписание» пять месяцев выглядело как «так
 * задумано».
 *
 * Тест читает ФАЙЛЫ: workflow-каталог и `lib/agents/cron-schedulers.ts`. Новый
 * роут без объявления — красный: молчание не считается ответом (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { DECLARED, EXTERNAL_SCHEDULE, MANUAL_ENDPOINTS, schedulerOf } from '@/lib/agents/cron-schedulers';

const WF_DIR = join(process.cwd(), '.github', 'workflows');
const CRON_DIR = join(process.cwd(), 'app', 'api', 'cron');

function endpointsOnDisk(): string[] {
  return readdirSync(CRON_DIR)
    .filter((d) => statSync(join(CRON_DIR, d)).isDirectory())
    .filter((d) => existsSync(join(CRON_DIR, d, 'route.ts')));
}

/**
 * Что запускается по расписанию GitHub Actions. Цепочка ровно в два звена:
 * workflow → адрес в самом yml, либо workflow → скрипт из `scripts/` → адрес
 * внутри скрипта. Второе звено обязательно: `evo-report` и
 * `ocr-passports-write` вызываются не из yml, а из `scripts/evo-report-issues.js`
 * и `scripts/ocr-opendataloader.mjs`, и без прохода по скриптам числились бы
 * незапланированными.
 */
function workflowDriven(): Set<string> {
  const names = new Set<string>();
  const addFrom = (src: string) => {
    for (const line of src.split('\n')) {
      const t = line.trimStart();
      if (t.startsWith('#') || t.startsWith('//') || t.startsWith('*')) continue;  // шапки не вызов
      for (const m of line.matchAll(/\/api\/cron\/([a-z0-9-]+)/g)) names.add(m[1]);
    }
  };
  for (const f of readdirSync(WF_DIR).filter((x) => x.endsWith('.yml') || x.endsWith('.yaml'))) {
    const src = readFileSync(join(WF_DIR, f), 'utf8');
    addFrom(src);
    for (const m of src.matchAll(/scripts\/[A-Za-z0-9._/-]+/g)) {
      const p = join(process.cwd(), m[0]);
      if (existsSync(p) && statSync(p).isFile()) addFrom(readFileSync(p, 'utf8'));
    }
  }
  return names;
}

describe('cron: у каждого эндпоинта назван запускающий', () => {
  it('нет роутов без workflow и без объявления', () => {
    const wf = workflowDriven();
    const undeclared = endpointsOnDisk().filter((e) => schedulerOf(e, wf) === 'undeclared');
    expect(
      undeclared,
      'роут под /api/cron/ без запускающего: либо дёргай из .github/workflows, ' +
      'либо объяви в lib/agents/cron-schedulers.ts как external или manual — ' +
      `${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('объявления не описывают несуществующие роуты', () => {
    const onDisk = new Set(endpointsOnDisk());
    const phantom = Object.keys(DECLARED).filter((e) => !onDisk.has(e));
    expect(phantom, `объявлен запускающий для отсутствующего роута: ${phantom.join(', ')}`).toEqual([]);
  });

  it('объявленное не дублирует workflow — иначе два разных ответа на один вопрос', () => {
    const wf = workflowDriven();
    const both = Object.keys(DECLARED).filter((e) => wf.has(e));
    expect(both, `и в workflow, и в объявлении: ${both.join(', ')}`).toEqual([]);
  });

  it('каждое объявление несёт причину, а не пустую строку', () => {
    const empty = Object.entries(DECLARED).filter(([, d]) => d.note.trim().length < 10).map(([k]) => k);
    expect(empty, `объявление без внятной причины: ${empty.join(', ')}`).toEqual([]);
  });

  it('external и manual не пересекаются', () => {
    const both = Object.keys(EXTERNAL_SCHEDULE).filter((k) => k in MANUAL_ENDPOINTS);
    expect(both).toEqual([]);
  });

  it('`payouts` числится внешним: деньги, чьё расписание нам не видно', () => {
    // Именной сторож. Если джобу когда-нибудь заведут в GitHub Actions, тест
    // упадёт и заставит убрать её отсюда — а не оставить два ответа сразу.
    expect(EXTERNAL_SCHEDULE.payouts?.kind).toBe('external');
    expect(schedulerOf('payouts', workflowDriven())).toBe('external');
  });
});
