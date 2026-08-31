/**
 * Перепись умеет ответить «упало правило или данные» ОДНИМ прогоном.
 *
 * ── Что случилось 31.08 ───────────────────────────────────────────────────
 *
 * Перепись покраснела: пригодных маршрутов 6 при пороге 193 (замер 215 от
 * 19.08). Находка честно назвала действие — «сверить navigability_reasons с
 * прошлой переписью: упало правило, порог или сами данные».
 *
 * Сверять оказалось НЕ С ЧЕМ. Перепись бежала три раза за всё время: 10.07
 * (зелёная, по пушу), 24.08 (отказ — ноль маршрутов), 31.08 (шесть).
 * Расписания GitHub до неё почти не доходят (задача #85), и порог 215 ни
 * одним её прогоном не воспроизводился.
 *
 * Сигнал, чьё действие невыполнимо, — это шум с хорошим тоном. Через неделю
 * его выключают, и ровно это `census-verdict` про себя и пишет.
 *
 * Поэтому вопрос переехал из времени в один прогон: то же правило считает
 * второй раз, не спрашивая род связи, — как считалось до миграции 874,
 * когда все связи числились путевыми. Расхождение двух чисел и есть цена
 * разметки.
 *
 * Сторож держит границу: это ДИАГНОСТИКА, а не второй вердикт. Судить ею
 * нельзя — иначе у платформы снова окажется два правила о том, что можно
 * обещать человеку как путь (§12).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const AUDIT = strip(read('lib/routes/geometry-audit.ts'));
const VERDICT = strip(read('lib/routes/census-verdict.ts'));

describe('контрфакт считается тем же правилом', () => {
  it('второго правила не заведено — зовётся routeNavigability', () => {
    const calls = [...AUDIT.matchAll(/routeNavigability\(\{/g)];
    // Вердикт + контрфакт. Третий вызов означал бы, что кто-то завёл ещё
    // одно суждение о пригодности.
    expect(calls.length).toBe(2);
  });

  it('отличается ровно одним: род связи не передаётся', () => {
    const at = AUDIT.indexOf('const navBeforeLinkKind');
    expect(at, 'контрфакта нет').toBeGreaterThan(0);
    const body = AUDIT.slice(at, at + 500);
    // Всё остальное — то же самое, иначе сравнивать нечего.
    expect(body).toMatch(/grade,/);
    expect(body).toMatch(/waypointTypes:/);
    expect(body).toMatch(/mode: detectTravelMode/);
    expect(body).toMatch(/evidence: evidenceVerdict/);
    // А род связи — нет: в этом весь смысл.
    expect(body).not.toMatch(/waypointKinds:/);
  });

  it('считает только пригодные — остальные вердикты не дублируются', () => {
    const at = AUDIT.indexOf('const navBeforeLinkKind');
    const body = AUDIT.slice(at, at + 700);
    expect(body).toMatch(/navBeforeLinkKind\.verdict === 'navigable'/);
    // Второй счётчик вердиктов сделал бы контрфакт похожим на вердикт.
    expect(body).not.toMatch(/verdicts\[navBeforeLinkKind/);
  });
});

describe('контрфакт не судит', () => {
  it('порогов по нему нет — иначе это второе правило', () => {
    expect(VERDICT).not.toMatch(/ignoring_link_kind/);
  });

  it('в пригодные маршруты для туров он не попадает', () => {
    // navigableIds кормит счёт туров «на пригодном маршруте». Подмешать
    // туда контрфакт значило бы посчитать туры на маршрутах, вести по
    // которым платформа права не имеет.
    const at = AUDIT.indexOf('navigableIds.push');
    expect(at).toBeGreaterThan(0);
    const line = AUDIT.slice(AUDIT.lastIndexOf('\n', at), at + 40);
    expect(line).not.toMatch(/navBeforeLinkKind/);
  });
});

describe('число объявлено в ответе аудита', () => {
  it('поле есть в интерфейсе и заполняется', () => {
    expect(AUDIT).toMatch(/navigable_ignoring_link_kind: number;/);
    expect(AUDIT).toMatch(/navigable_ignoring_link_kind: navigableIgnoringLinkKind,/);
  });
});
