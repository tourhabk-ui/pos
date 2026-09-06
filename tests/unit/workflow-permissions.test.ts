/**
 * Сторож прав GITHUB_TOKEN в workflow.
 *
 * actions/missing-workflow-permissions, 3 находки языка `actions`
 * (CodeQL, 23.08.2026): джоб без явного блока `permissions` получает токен с
 * правами по умолчанию — шире, чем ему нужно.
 *
 * ЗАМЕР, который стоит помнить: без блока `permissions` в репозитории
 * 86 workflow из 104, а CodeQL отметил ТРИ. По какому признаку он отобрал
 * именно их — не установлено. Поэтому правились ровно отмеченные, и минимум
 * выведен из шагов каждого, а не из подсказки правила:
 *
 *   shannon-pentest     → contents: read  (actions/checkout; upload-artifact
 *                         работает рантайм-токеном, областей не требует)
 *   waypoint-proposals  → {}  (curl на vedarai.ru + $GITHUB_STEP_SUMMARY)
 *   timeweb-app-info    → {}  (один GET к API Timeweb своим токеном)
 *
 * Пройтись по остальным 86 «заодно» нельзя: многие пушат коммиты и зовут gh,
 * и сужение прав сломает их молча — красным станет не тест, а ночной прогон.
 * Это отдельная работа с чтением каждого.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WF_DIR = join(process.cwd(), '.github/workflows');
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const hasPermissions = (f: string) => /^\s*permissions:/m.test(readFileSync(join(WF_DIR, f), 'utf8'));

/** Разобранные поимённо. Список может только РАСТИ. */
const DECLARED = ['shannon-pentest.yml', 'waypoint-proposals.yml', 'timeweb-app-info.yml',
  'kvert-probe.yml', 'feeds-probe.yml'];

/**
 * Отложенных не осталось.
 *
 * Обе пробы разведки (`kvert-probe.yml`, `feeds-probe.yml`) просили ровно
 * `contents: read` и с 06.09 объявляют это в самих файлах. Список оставлен
 * пустым намеренно: место для следующего разобранного, но ещё не записанного
 * случая — и оно должно оставаться пустым.
 */
const PENDING: string[] = [];

describe('права токена объявлены там, где разобраны', () => {
  it('все отмеченные workflow объявляют permissions', () => {
    const missing = DECLARED.filter((f) => !hasPermissions(f));
    expect(missing, `объявление прав пропало: ${missing.join(', ')}`).toEqual([]);
  });

  it('shannon-pentest просит ровно contents: read', () => {
    const src = readFileSync(join(WF_DIR, 'shannon-pentest.yml'), 'utf8');
    expect(src).toMatch(/^permissions:\n  contents: read$/m);
  });

  it('обе пробы разведки просят ровно contents: read', () => {
    for (const f of ['kvert-probe.yml', 'feeds-probe.yml']) {
      expect(readFileSync(join(WF_DIR, f), 'utf8'), f).toMatch(/^permissions:\n  contents: read$/m);
    }
  });

  it('двум разборам токен не нужен вовсе', () => {
    for (const f of ['waypoint-proposals.yml', 'timeweb-app-info.yml']) {
      expect(readFileSync(join(WF_DIR, f), 'utf8'), f).toMatch(/^permissions: \{\}$/m);
    }
  });
});

describe('перепись остальных: цифра записана, а не забыта', () => {
  it('workflow без объявления прав не становится больше', () => {
    // Потолок — замер 06.09.2026 (85 из 131 сверх PENDING; было 86 из 104
    // на 23.08). Он может только СОКРАЩАТЬСЯ: новый workflow без блока
    // permissions покраснеет здесь и заставит решить осознанно, а не
    // унаследовать умолчание.
    //
    // Красным он стал с опозданием на два PR: сам этот сторож живёт в CI, а
    // CI не поднимается на PR, который трогает ТОЛЬКО .github/workflows/*
    // (в его paths-фильтре из всего каталога перечислен один ci.yml). Так
    // обе пробы разведки вошли в main непроверенными.
    const CEILING = 85;
    const without = files.filter((f) => !hasPermissions(f) && !PENDING.includes(f));
    expect(
      without.length,
      `workflow без permissions стало больше замера: ${without.length} против ${CEILING}`,
    ).toBeLessThanOrEqual(CEILING);
  });

  it('отложенные не растворяются: каждый файл из PENDING существует и ждёт ровно contents: read', () => {
    const gone = PENDING.filter((f) => !files.includes(f));
    expect(gone, `файла нет — строку из PENDING надо удалить: ${gone.join(', ')}`).toEqual([]);
  });
});
