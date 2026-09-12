/**
 * Написанная e2e-спека обязана кем-то вызываться.
 *
 * ── Что нашлось 12.09 ─────────────────────────────────────────────────────
 *
 * В `test/e2e/` лежало пять спек, а гонялись две. `booking-flow.spec.ts`,
 * `quality-gates.spec.ts` и `seo-flows.spec.ts` не вызывались ни одним
 * workflow: ночной прогон называет спеки ПОИМЁННО, и эти три в список не
 * попали. 242 строки проверок, не исполнявшихся с 14 августа.
 *
 * Среди них — «booking modal requires auth», «POST /api/bookings requires
 * auth», «admin routes return 401 without token», «operator routes return
 * 401 without token». Проверки авторизации на денежном пути были написаны и
 * ни разу не запускались. Файл в репозитории читается как «проверено»;
 * признака обратного не было никакого.
 *
 * Правило 10.09 в чистом виде: у объявленного обязан быть производитель.
 * Спека — объявление («это поведение проверяется»), вызов в workflow —
 * механизм. Разошлись молча и на четыре недели.
 *
 * ── Почему `npm run test:e2e` вызовом НЕ считается ────────────────────────
 *
 * Первая редакция этого сторожа собирала «места вызова» из workflow И из
 * `package.json` — и зеленела ни на чём: скрипт `"test:e2e": "playwright
 * test"` запускает весь каталог, поэтому любая спека считалась вызванной,
 * даже когда её не гонял никто. Сторож, написанный ради конкретного
 * дефекта, этот самый дефект пропускал.
 *
 * Поэтому вызовом считается только прогон в workflow. Локальный скрипт,
 * который в CI не запускается (а против localhost ещё и требует поднятой
 * базы), — это возможность запустить, а не запуск. Разница ровно та же, что
 * между «репозиторий может ответить» и «репозиторий говорит».
 *
 * Сама логика вынесена в чистую функцию и проверяется на синтетических
 * входах ниже: детектор, который умеет только не находить, зеленеет и когда
 * сломан.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const E2E_DIR = 'test/e2e';
const SMOKE_WF = '.github/workflows/e2e-smoke.yml';

/** Все спеки на диске. */
function specFiles(): string[] {
  return readdirSync(join(ROOT, E2E_DIR))
    .filter((f) => f.endsWith('.spec.ts'))
    .sort();
}

/**
 * Тексты ВСЕХ workflow. Читаются с диска, а не перечисляются здесь:
 * замороженный список мест вызова устарел бы молча — та же болезнь.
 */
function workflowSources(): string {
  const dir = join(ROOT, '.github/workflows');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => readFileSync(join(dir, f), 'utf-8'))
    .join('\n');
}

/**
 * Вызвана ли спека: названа поимённо ЛИБО попадает под прогон всего каталога
 * (`playwright test` без списка файлов) — но и то и другое ТОЛЬКО в workflow.
 */
export function isInvoked(spec: string, workflows: string): boolean {
  if (workflows.includes(spec)) return true;
  // `playwright test` без единого пути: дальше либо конец строки, либо флаг.
  return /playwright test(?:\s+--[^\s]+)*\s*$/m.test(workflows);
}

describe('детектор вызова умеет находить и не находить', () => {
  // Положительный контроль. Без него всё, что ниже, ничего не стоит: первая
  // редакция сторожа зеленела на пустом месте и была бы зелёной вчера тоже.
  it('видит поимённый вызов', () => {
    expect(isInvoked('booking-flow.spec.ts', 'run: npx playwright test test/e2e/booking-flow.spec.ts --project=chromium')).toBe(true);
  });

  it('НЕ видит вызова, когда его нет', () => {
    expect(isInvoked('booking-flow.spec.ts', 'run: npx playwright test test/e2e/smoke.spec.ts --project=chromium')).toBe(false);
  });

  it('видит прогон всего каталога', () => {
    expect(isInvoked('booking-flow.spec.ts', 'run: npx playwright test --project=chromium')).toBe(true);
  });

  it('локальный скрипт package.json вызовом не считается', () => {
    // Именно это зеленило первую редакцию: в CI он не запускается.
    expect(isInvoked('booking-flow.spec.ts', '"test:e2e": "playwright test",')).toBe(false);
  });
});

describe('e2e: каждая спека кем-то запускается', () => {
  it('спеки вообще есть — иначе проверка ниже бессмысленна', () => {
    expect(specFiles().length).toBeGreaterThanOrEqual(3);
  });

  it('ни одна спека не лежит без вызова', () => {
    const wf = workflowSources();
    const orphans = specFiles().filter((s) => !isInvoked(s, wf));
    expect(
      orphans,
      'спека написана и не вызывается ни одним workflow — файл читается как '
        + '«проверено», а не проверяется ничего. Внести её в прогон '
        + '(.github/workflows/e2e-smoke.yml) или удалить вместе с обещанием.',
    ).toEqual([]);
  });

  it('те три, из-за которых сторож заведён, действительно в ночном прогоне', () => {
    // Отдельной строкой и поимённо: общая проверка выше зазеленеет и если
    // спеку удалить, а вопрос был не «нет сирот», а «эти проверки идут».
    const wf = readFileSync(join(ROOT, SMOKE_WF), 'utf-8');
    for (const spec of ['booking-flow.spec.ts', 'quality-gates.spec.ts', 'seo-flows.spec.ts']) {
      expect(wf, `${spec} снова выпала из ночного прогона`).toContain(spec);
    }
  });

  it('падение этих трёх отличимо от падения витрины', () => {
    // Отдельный шаг, а не дописывание в ту же строку: имя шага в логе
    // говорит, ЧТО упало, и разбирающему не придётся гадать, прод сломался
    // или устарел селектор в спеке, четыре недели лежавшей без дела.
    const wf = readFileSync(join(ROOT, SMOKE_WF), 'utf-8');
    const runSteps = (wf.match(/- name: Run [^\n]*/g) ?? []).filter((s) => /Run (smoke|booking)/.test(s));
    expect(runSteps.length, 'группы прогонов слиты в один шаг — причина падения снова неразличима')
      .toBeGreaterThanOrEqual(2);
  });
});
