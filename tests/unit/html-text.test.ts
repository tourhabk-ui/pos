/**
 * Сторож разбора чужого HTML: закрывающий тег читается как браузером.
 *
 * 23.08.2026 CodeQL напечатал 44 находки на этом разборе — два разных дефекта
 * в одних и тех же тридцати функциях:
 *
 *   js/bad-tag-filter (7) — `<\/script>` требовал закрывающий тег ровно таким.
 *     Браузер принимает `</script >`, `</script\n>`, `</script foo>`: атрибуты
 *     закрывающего тега он игнорирует. Тело скрипта с чужого сайта оставалось
 *     в «тексте страницы» и уезжало дальше — в промпт модели, в описание
 *     маршрута, в пост канала.
 *
 *   js/incomplete-multi-character-sanitization (37) — снятие за один проход.
 *
 * Правильная реализация в репозитории уже была — lib/partners/prospect-parse,
 * пережившая две итерации находок на PR #1232. Она осталась внутри файла, и
 * потому разбор написали заново тридцать раз.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { stripTags, stripScriptsAndStyles, htmlToText } from '@/lib/html/text';

describe('закрывающий тег: как у браузера, а не как в учебнике', () => {
  it('</script > с пробелом — тело всё равно снимается', () => {
    expect(stripTags('a<script>alert(1)</script >b')).toBe('ab');
  });

  it('</script foo> с атрибутом — тоже', () => {
    expect(stripTags('a<script>alert(1)</script foo>b')).toBe('ab');
  });

  it('незакрытый script в обрезанном HTML не оставляет тела', () => {
    // HTML режут по потолку размера; хвост — не текст страницы.
    expect(stripTags('a<script>alert(1)')).toBe('a');
  });

  it('стили — по тому же правилу', () => {
    expect(stripTags('a<style>.x{}</style >b')).toBe('ab');
  });

  it('старая регулярка на тех же входах тело ОСТАВЛЯЛА', () => {
    // Негативный контроль: без него не видно, что сторож вообще что-то ловит.
    //
    // CodeQL метит эти две строки на каждом прогоне — образец дефекта под
    // проверкой он от очистки не отличает. Это ПРИНЯТАЯ ЦЕНА: недоказанный
    // сторож хуже двух объяснённых находок в отчёте.
    //
    // 23.08.2026 я пробовал спрятать шаблон, собрав его через `new RegExp` из
    // строки. Замерено: из трёх находок ушла ОДНА (17 → 16) — сканер видит
    // конструктор насквозь. Усложнение того не стоило, форма возвращена
    // простая. Не повторять.
    const old = (s: string) => s
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '');

    expect(old('a<script>alert(1)</script >b')).toContain('alert(1)');
    expect(stripTags('a<script>alert(1)</script >b')).not.toContain('alert(1)');
  });
});

describe('снятие тегов', () => {
  it('незакрытый тег в конце документа не остаётся текстом', () => {
    expect(stripTags('текст<div class="x')).toBe('текст');
  });

  it('сравнение чисел не съедается', () => {
    // `<[^>]+>` не требовал имени тега после `<` и глотал «1 < 2 и 3 > 4»
    // целиком. CodeQL про это не говорил — но текст портился.
    expect(stripTags('1 < 2 и 3 > 4')).toBe('1 < 2 и 3 > 4');
  });

  it('разделитель сохраняется таким, каким был на месте вызова', () => {
    expect(stripTags('<p>а</p><p>б</p>')).toBe('аб');
    expect(stripTags('<p>а</p><p>б</p>', ' ')).toBe(' а  б ');
  });

  it('комментарии снимаются, включая незакрытый', () => {
    expect(stripTags('а<!-- прячу -->б')).toBe('аб');
    expect(stripTags('а<!-- обрыв')).toBe('а');
  });
});

describe('stripScriptsAndStyles: разметка остаётся', () => {
  it('снимает скрипты, но не трогает прочие теги', () => {
    const out = stripScriptsAndStyles('<div><script>x</script ><b>т</b></div>', '');
    expect(out).toBe('<div><b>т</b></div>');
  });
});

describe('htmlToText: проза с абзацами', () => {
  it('переводы строк из br и закрытия блока', () => {
    // Пробел после перевода строки — поведение ПРЕЖНЕЙ реализации, сверено
    // посимвольно: открывающий `<p>` даёт разделитель. Менять его заодно с
    // починкой не стал.
    expect(htmlToText('<p>раз</p><p>два</p>')).toBe('раз\n два');
    expect(htmlToText('а<br>б')).toBe('а\nб');
  });
});

describe('разбор в репозитории один', () => {
  const SKIP = new Set(['node_modules', '.next', '.git', '.claude', 'public', 'migrations', 'docs', 'tests']);
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx|js|mjs)$/.test(e)) acc.push(p);
    }
    return acc;
  };
  const SHARED = join('lib', 'html', 'text.js');

  it('никто не требует закрывающий тег ровно `</script>`', () => {
    const offenders = walk(process.cwd())
      .filter((f) => !f.endsWith(SHARED))
      .filter((f) => {
        const src = readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
        // Именно replace: `.match(/<script id="__NEXT_DATA__"…<\/script>/)` —
        // ИЗВЛЕЧЕНИЕ конкретного тега, а не снятие. Промах там даёт пустой
        // результат, а не утечку тела скрипта.
        return /replace\(\s*\/<(script|style)\b[\s\S]{0,80}?<\\\/(script|style)>/.test(src);
      })
      .map((f) => f.replace(process.cwd() + '/', ''));
    expect(offenders, `закрывающий тег снова требуется точным: ${offenders.join(', ')}`).toEqual([]);
  });

  it('никто не снимает теги своей регуляркой', () => {
    const offenders = walk(process.cwd())
      .filter((f) => !f.endsWith(SHARED))
      .filter((f) => {
        const src = readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
        return /replace\(\s*\/<\[\^>\][+*]>\//.test(src);
      })
      .map((f) => f.replace(process.cwd() + '/', ''));
    expect(offenders, `свой разбор вернулся: ${offenders.join(', ')}`).toEqual([]);
  });
});
