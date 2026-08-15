/**
 * Витринные счётчики не держат выкладку продукта.
 *
 * 15.08 проверка `update-readme-stats --check` стояла ПЕРВЫМ шагом CI и
 * роняла весь job, а деплой на Timeweb висит на «CI завершился успехом».
 * Числа (страницы, API routes, lib-модули, количество тестов) меняются от
 * каждого мержа, поэтому ветка, прошедшая CI со своими цифрами, после
 * слияния приносила на main устаревшие.
 *
 * Получался замкнутый круг: коммит с кодом делал README устаревшим (CI
 * красный → деплой пропущен), а коммит, чинящий README, не запускал CI
 * вовсе — `.md` нет в путях-триггерах. Прод простоял пять часов, и это
 * стоило дороже, чем всё, что в тот вечер было написано.
 *
 * Хуже того: падая первым шагом, проверка не давала выполниться tsc и
 * тестам — настоящая проверка кода на main не запускалась.
 *
 * Свежесть счётчиков теперь поддерживает post-merge.yml автоматически.
 * Этот сторож держит решение: счётчики обновляются, а не блокируют.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const CI = read('.github/workflows/ci.yml');
const POST_MERGE = read('.github/workflows/post-merge.yml');
const DEPLOY = read('.github/workflows/deploy.yml');

describe('CI не падает на счётчиках README', () => {
  it('шага с --check в блокирующем CI нет', () => {
    const code = CI.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/update-readme-stats\.mjs --check/);
  });

  it('настоящие проверки в CI остались', () => {
    expect(CI).toMatch(/tsc --noEmit/);
    expect(CI).toMatch(/vitest run/);
  });
});

describe('счётчики обновляются сами после мержа', () => {
  it('post-merge регенерирует и коммитит README', () => {
    expect(POST_MERGE).toMatch(/update-readme-stats\.mjs/);
    expect(POST_MERGE).toMatch(/README-stats: автообновление/);
    expect(POST_MERGE).toMatch(/contents: write/);
  });

  it('петли нет: коммит помечен skip ci, а .md не в триггерах CI', () => {
    expect(POST_MERGE).toMatch(/\[skip ci\]/);
    // Пути-триггеры CI перечисляют исходники; markdown среди них нет.
    const triggers = CI.slice(0, CI.indexOf('jobs:'));
    expect(triggers).not.toMatch(/\*\*\/\*\.md/);
  });

  it('гонка с параллельными мержами не роняет job', () => {
    // Push может не пройти: main ушёл вперёд. Тогда пересчитать и повторить,
    // а не падать — цифры не повод для красного workflow.
    expect(POST_MERGE).toMatch(/git fetch origin main/);
    expect(POST_MERGE).toMatch(/не критично/);
  });
});

describe('деплой по-прежнему требует зелёного CI', () => {
  it('условие успеха не ослаблено — убрана причина, а не защита', () => {
    expect(DEPLOY).toMatch(/workflow_run\.conclusion == 'success'/);
  });
});
