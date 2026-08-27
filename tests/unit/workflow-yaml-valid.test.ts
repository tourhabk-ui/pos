/**
 * Каждый workflow-файл обязан быть валидным YAML.
 *
 * Находка 27.08: evo-review.yml (PR #1390) содержал python-heredoc внутри
 * `run: |`, где строки кода шли от нулевой колонки. В YAML литеральный блок
 * кончается на первой строке с отступом МЕНЬШЕ базового — блок разорвался,
 * файл перестал парситься. GitHub на невалидный workflow-файл не говорит
 * ничего внятного: он просто создаёт КРАСНЫЙ прогон с нулём джобов на каждый
 * push в ЛЮБУЮ ветку — и не запускает ни расписание, ни файл-маркер. Двое
 * суток «первый боевой прогон AI-ревью» не существовал, а 40 красных
 * огрызков в ленте Actions никто не связал с причиной.
 *
 * Ни один существующий сторож этот класс не ловил: cron-registry-honesty
 * читает workflow'ы регексами (регексу разорванный YAML безразличен), а
 * тесты самих фич проверяют .ts-код, не .yml. Здесь — настоящий парс всех
 * файлов, тем же классом парсера, что у GitHub (YAML 1.1/1.2 — js-yaml).
 *
 * js-yaml берётся из node_modules (транзитивная зависимость), типов у него
 * нет — createRequire с явным кастом. Если зависимость исчезнет, тест упадёт
 * на require — это громкий отказ, не тихий пропуск (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const { load } = requireCjs('js-yaml') as { load: (src: string) => unknown };

const WF_DIR = join(process.cwd(), '.github', 'workflows');
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('workflow-файлы парсятся как YAML', () => {
  it('workflow-файлы найдены', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s — валидный YAML с jobs', (file) => {
    const src = readFileSync(join(WF_DIR, file), 'utf-8');
    let doc: unknown;
    expect(() => { doc = load(src); }, `${file} не парсится — GitHub будет плодить красные прогоны с нулём джобов на каждый push`).not.toThrow();
    // Разорванный блок может и распарситься — в мусорную структуру. Каркас
    // workflow обязан быть на месте: jobs со хотя бы одной джобой.
    const wf = doc as { jobs?: Record<string, unknown> } | null;
    expect(wf?.jobs && typeof wf.jobs === 'object', `${file}: нет секции jobs — файл распарсился в мусор`).toBeTruthy();
    expect(Object.keys(wf?.jobs ?? {}).length, `${file}: секция jobs пуста`).toBeGreaterThan(0);
  });
});
