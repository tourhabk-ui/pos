/**
 * Бренд-канон: публичный бренд — «Ведар» (lib/config SITE_NAME).
 * Тест ловит регресс: TourHab/KamchatourHub в публичных метаданных и дубль-суффикс title.
 *
 * Вне scope (осознанно НЕ проверяется):
 *  - app/api/**            — email/telegram/gpx/ical шаблоны (отдельная задача)
 *  - app/legal/**          — тела юрдокументов (правовое решение, не косметика)
 *  - домены: миграция tourhab.ru → vedarai.ru выполнена (июль 2026);
 *    остаточные tourhab.ru — только email-адреса (@tourhab.ru, почтовый домен),
 *    affiliate-аккаунты и app/api/payments (§7)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'api' || name === 'legal' || name === 'node_modules') continue;
      collect(p, acc);
    } else if (/\.(ts|tsx)$/.test(name)) {
      acc.push(p);
    }
  }
  return acc;
}

const files = [...collect(join(ROOT, 'app')), ...collect(join(ROOT, 'components'))];

/** Все .ts/.tsx каталога без исключений — для app/legal, где нужны только метаданные. */
function collectAll(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectAll(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('бренд-канон «Ведар» в публичных поверхностях', () => {
  it('siteName нигде не TourHab/KamchatourHub', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      if (/siteName:\s*['"`](TourHab|KamchatourHub)['"`]/.test(src)) offenders.push(f);
    }
    expect(offenders, `siteName с legacy-брендом:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('title не содержит legacy-суффиксов (| TourHab, | Tourhab, | Kamchatour, | KamchatourHub)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        if (!/\btitle\s*[:=]/.test(line)) continue;
        if (/\|\s*(TourHab|Tourhab|KamchatourHub|Kamchatour)\b/.test(line) || /—\s*(TourHab|Tourhab|KamchatourHub|Kamchatour)\s*['"`]/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    expect(offenders, `title с legacy-суффиксом:\n${offenders.join('\n')}`).toEqual([]);
  });

  // Аудит SEO 29.09, вечер. Каталог app/legal исключён выше ради ТЕЛ
  // документов, и вместе с ними выпал шаблон заголовков юрраздела: пять
  // страниц sitemap уходили в выдачу как «… | Tourhab». Шаблон — метаданные,
  // поэтому проверяется отдельно; тела и REQUISITES по-прежнему вне scope.
  it('шаблон заголовков юрраздела — бренд «Ведар»', () => {
    const src = readFileSync(join(ROOT, 'app/legal/layout.tsx'), 'utf-8');
    expect(src).toMatch(/template:\s*'%s \| Ведар'/);
    expect(src).not.toMatch(/TourHab|Tourhab|KamchatourHub|Kamchatour/);
  });

  it('title не заканчивается на «— Ведар» (шаблон доклеит «| Ведар» — бренд дважды)', () => {
    const legalPages = collectAll(join(ROOT, 'app', 'legal'));
    const offenders: string[] = [];
    for (const f of [...files, ...legalPages]) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        if (line.includes('template:')) continue;
        if (/^\s*title\s*:/.test(line) && /—\s*Ведар\s*['"`]/.test(line)) offenders.push(`${f}:${i + 1}`);
      }
    }
    expect(offenders, `title с ручным «— Ведар» (даст «— Ведар | Ведар»):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('старый бренд кириллицей и «Ведар 2026» / «— Блог Ведара» в title (шаблон доклеит ещё «| Ведар»)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        if (line.includes('template:') || !/^\s*title\s*:/.test(line)) continue;
        if (/КамчатурХаб|Камчатур\s*Хаб|ТурХаб/i.test(line) || /Ведар\s+20\d\d/.test(line) || /—\s*Блог Ведара/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    expect(offenders, `title со старым брендом или брендом дважды:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('description юрстраниц — бренд «Ведар» (тела документов вне scope)', () => {
    const offenders: string[] = [];
    for (const f of collectAll(join(ROOT, 'app', 'legal'))) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        if (/^\s*description\s*:/.test(line) && /TourHab|Tourhab|KamchatourHub/.test(line)) offenders.push(`${f}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Описания MCP-инструментов индексируют каталоги (Smithery, Glama, реестр
  // MCP) и читают чужие агенты: «из платформы TourHab» стояло в четырёх из
  // четырнадцати (живая проба 29.09). Проверяется ровно то, что уходит наружу.
  it('MCP: карточка сервера и описания инструментов — без старого бренда', async () => {
    const { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO } = await import('@/lib/mcp/public-tools');
    const outward = JSON.stringify({ MCP_SERVER_INFO, PUBLIC_MCP_TOOLS });
    expect(outward.length).toBeGreaterThan(5000);
    expect(outward).not.toMatch(/TourHab|Tourhab|KamchatourHub|КамчатурХаб/);
  });

  // Приветствие и справка чат-бота Кузьмича — тоже наружу: /start и /help
  // называли «AI-агент платформы TourHab» (сверка 29.09).
  it('Кузьмич представляется Ведаром, а не старым брендом', () => {
    const code = readFileSync('lib/kuzmich/core.ts', 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/TourHab|Tourhab|KamchatourHub|КамчатурХаб/);
  });

  it('публичный JSON-LD не называет организацию старым брендом', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      if (/'@type':\s*'Organization',\s*name:\s*'(TourHab|Tourhab|KamchatourHub)'/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('title не заканчивается на "| Ведар" (root layout template доклеит второй — дубль)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(f, 'utf-8').split('\n').entries()) {
        // template в root layout — легитимное место '%s | Ведар'
        if (line.includes("template:")) continue;
        if (/\btitle\s*[:=]/.test(line) && /\|\s*Ведар\s*['"`]/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    expect(offenders, `title с ручным "| Ведар" (даст дубль):\n${offenders.join('\n')}`).toEqual([]);
  });
});
