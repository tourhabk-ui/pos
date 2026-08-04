/**
 * Прод собирается на той же версии Node, на которой мы проверяем.
 *
 * 04.08 — три дня «не можем починить баги». Расследование: код в main был
 * верный, а на прод не доезжал ни один деплой. `next build` падал в Docker с
 * `TypeError: webidl.util.markAsUncloneable is not a function` на сборе данных
 * для /api/cron/import-routes.
 *
 * Цепочка: dependabot поднял jsdom 29 → 30 (#956), тот притащил undici 8,
 * undici 8 зовёт `markAsUncloneable`, которой нет в Node 20. CI и разработка
 * шли на Node 22 — там всё зелено; образ собирался на node:20-alpine. Я мержил
 * обновление после «локальной проверки», и проверка была честной: просто она
 * гонялась не на том рантайме, что прод.
 *
 * Расхождение версий рантайма — это не гигиена, а способ получить зелёные
 * проверки при мёртвом проде. Здесь оно становится ошибкой сборки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Мажорная версия из `FROM node:22-alpine`. */
function dockerNodeMajor(): number {
  const m = read('Dockerfile').match(/^FROM node:(\d+)/m);
  expect(m, 'в Dockerfile не найден базовый образ node').not.toBeNull();
  return Number(m![1]);
}

/** Мажорные версии из всех `node-version:` в workflow-файлах. */
function ciNodeMajors(): number[] {
  const files = ['ci.yml', 'codeql.yml', 'design-token-gate.yml'];
  const out: number[] = [];
  for (const f of files) {
    let src: string;
    try { src = read(join('.github/workflows', f)); } catch { continue; }
    for (const m of src.matchAll(/node-version:\s*'?"?(\d+)/g)) out.push(Number(m[1]));
  }
  return out;
}

function enginesMajor(): number {
  const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
  const spec = pkg.engines?.node;
  expect(spec, 'в package.json нет engines.node — версия рантайма нигде не объявлена').toBeTruthy();
  const m = spec!.match(/(\d+)/);
  return Number(m![1]);
}

describe('версия Node одна и та же везде', () => {
  it('образ собирается на той же мажорной версии, что и CI', () => {
    const docker = dockerNodeMajor();
    const ci = ciNodeMajors();
    expect(ci.length, 'ни один workflow не задаёт node-version — сравнивать не с чем').toBeGreaterThan(0);
    for (const v of ci) {
      expect(v, `CI гоняется на Node ${v}, а образ собирается на ${docker}`).toBe(docker);
    }
  });

  it('объявленная в package.json версия совпадает с образом', () => {
    expect(enginesMajor()).toBe(dockerNodeMajor());
  });

  it('версия не ниже 22 — на 20 падает undici 8 из jsdom', () => {
    // Конкретная нижняя граница, а не «посвежее»: именно на 20 отсутствует
    // markAsUncloneable, и именно это уронило пять деплоев подряд.
    expect(dockerNodeMajor()).toBeGreaterThanOrEqual(22);
  });
});
