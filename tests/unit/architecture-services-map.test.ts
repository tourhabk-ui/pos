/**
 * Карта `lib/services/` в docs/ARCHITECTURE.md сверяется с диском.
 *
 * ── Что нашлось 14.09 ─────────────────────────────────────────────────────
 *
 * Разбор находки эволюции про сбои авиаперелётов (#1885) начался с вопроса
 * «есть ли у платформы сервис перелётов». Карта архитектуры отвечала «есть»:
 * в строке core/platform значился `flights`, рядом `hotels`, `insurance` и
 * `transfers`. На диске нет ни одного из четырёх — ни файла, ни папки.
 *
 * Расхождение оказалось двусторонним и повсеместным:
 *
 *   обещано, но нет   — flights, hotels, insurance, transfers;
 *   есть, но не названо — папки intelligence/, relief/, scout/ целиком;
 *   названо неполно   — safety/: семь файлов из восемнадцати;
 *   названо после удаления — idilesom-importer, вычищенный решением
 *                            владельца 07.09 вместе со всем скрейпом.
 *
 * Каждая из четырёх форм врёт по-своему, но последствие одно: читающий карту
 * верит карте. «Сервис перелётов есть, надо дописать» — вывод, который она
 * подсказывала, а кода за ним нет. Это правило 10.09 в чистом виде: описание
 * живёт дольше кода, и внешним взглядом по документу этого не увидеть
 * принципиально — документ оценивают как текст, а не как утверждение о диске.
 *
 * ── Почему сторож, а не разовая правка ────────────────────────────────────
 *
 * Карту уже правили руками — на то она и «живой словарь». Раз в несколько
 * месяцев она снова разойдётся, и следующий раз тоже будет молчаливым.
 * Сторож переводит её из обещания в утверждение, которое можно опровергнуть:
 * добавил сервис и не вписал — сборка красная; вписал несуществующий — тоже.
 *
 * Тестовые файлы (`*.test.ts`) в карте не перечисляются: она про домены, а не
 * про покрытие.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SERVICES = join(ROOT, 'lib', 'services');
const DOC = readFileSync(join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf-8');

/** Имена сервисов на диске: ключ — `tours/` или `корень`, значение — файлы без .ts */
function onDisk(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const rootFiles = new Set<string>();
  for (const entry of readdirSync(SERVICES)) {
    const full = join(SERVICES, entry);
    if (statSync(full).isDirectory()) {
      const files = readdirSync(full)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => f.replace(/\.ts$/, ''));
      out.set(`${entry}/`, new Set(files));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      rootFiles.add(entry.replace(/\.ts$/, ''));
    }
  }
  out.set('корень', rootFiles);
  return out;
}

/**
 * Карта из §3 документа. Строка таблицы: `| `tours/` | a, b, c |`.
 * Обратные кавычки и пояснения в скобках снимаются — они для человека.
 */
function inDoc(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const section = DOC.slice(DOC.indexOf('## 3. Карта lib/services/'));
  const table = section.slice(0, section.indexOf('\n\nБаррел'));
  for (const line of table.split('\n')) {
    const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/`/g, '').replace(/\s*\(.*\)\s*/, '').trim();
    if (key === 'Подпапка' || /^-+$/.test(key)) continue;
    const files = m[2]
      .split(',')
      .map((s) => s.replace(/`/g, '').replace(/\([^)]*\)/g, '').trim())
      .filter((s) => s.length > 0);
    out.set(key, new Set(files));
  }
  return out;
}

describe('карта lib/services в ARCHITECTURE.md — утверждение о диске, а не обещание', () => {
  const disk = onDisk();
  const doc = inDoc();

  it('разбор таблицы не пустой', () => {
    // Иначе сторож зеленел бы на сломанном разборе: ноль находок неотличим от
    // нуля расхождений (§4.0).
    expect(doc.size, 'таблица §3 не разобралась').toBeGreaterThan(5);
    expect(disk.size).toBeGreaterThan(5);
  });

  it('в карте нет папок, которых нет на диске', () => {
    const ghosts = [...doc.keys()].filter((k) => !disk.has(k));
    expect(ghosts, 'карта называет несуществующие разделы').toEqual([]);
  });

  it('на диске нет папок, которых нет в карте', () => {
    const missing = [...disk.keys()].filter((k) => !doc.has(k));
    expect(
      missing,
      'раздел lib/services есть, а в карте его нет: читающий карту о нём не узнает',
    ).toEqual([]);
  });

  it('состав каждого раздела совпадает', () => {
    const problems: string[] = [];
    for (const [key, files] of disk) {
      const named = doc.get(key);
      if (!named) continue; // покрыто проверкой выше
      for (const f of files) {
        if (!named.has(f)) problems.push(`${key}: на диске есть ${f}, в карте нет`);
      }
      for (const f of named) {
        if (!files.has(f)) problems.push(`${key}: карта обещает ${f}, на диске нет`);
      }
    }
    expect(problems, 'карта разошлась с кодом').toEqual([]);
  });
});
