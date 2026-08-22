/**
 * Сторож достижимости: числа переписи не растут молча.
 *
 * Перепись экспортов и перепись достижимости разобрали четыре поверхности и
 * оставили на каждой ровно то, что решено оставить. Но сам СЧЁТ до сих пор не
 * держал никто: новая страница без ссылки, новый компонент без импортёра или
 * новая сирота-функция появились бы завтра и прошли бы незамеченными — ровно
 * так набралось 96 сирот и 15 недостижимых страниц.
 *
 * Тест не запрещает добавлять поверхности. Он запрещает добавлять их МОЛЧА:
 * порог сдвигается тем же коммитом, что и причина, и причина остаётся в
 * истории рядом с числом.
 *
 * Пороги — потолки, а не цели. Уменьшать можно и нужно; тест напомнит, когда
 * фактическое число ушло заметно ниже, чтобы потолок не превратился в обещание
 * держать мусор.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

const SCRIPT = join(process.cwd(), 'scripts', 'reachability-audit.ts');

/** Потолки на 22.08.2026. Каждый — с причиной, почему не ноль. */
const CEILING = {
  // Было 15, после правок 22.08 — 9, и все девять законны: пять редиректов
  // на сохранённые URL (/cart, /kuzmich/hub, /hub/operator/register,
  // /hub/tourist/eco-points, /tp-verify как верификация TravelPayouts), две
  // токен-ссылки (/briefing, виджет), вход по роли (/hub/gear) и полевой
  // адрес (/field-check). Один слот запаса — на следующий законный редирект.
  pages: 10,
  // Ноль. Компонент без импортёра — это либо забытая работа, либо удаление,
  // которое не довели; и то и другое требует решения, а не потолка.
  components: 0,
} as const;

function count(kind: 'pages' | 'components'): { total: number; orphans: string[] } {
  const out = execFileSync('npx', ['tsx', SCRIPT, kind], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 180_000,
  });
  const orphans = out.split('\n').filter((l) => /^\s{2}\S/.test(l)).map((l) => l.trim().split('   ')[0]);
  const m = /всего (\d+)/.exec(out);
  return { total: m ? Number(m[1]) : -1, orphans };
}

describe('перепись достижимости: числа заморожены', () => {
  it('страниц без ссылки из интерфейса не больше потолка', () => {
    const { total, orphans } = count('pages');
    expect(total).toBeGreaterThan(100);          // измерение вообще состоялось
    expect(
      orphans.length,
      `недостижимых страниц ${orphans.length} > ${CEILING.pages}. Новая страница без ссылки — ` +
      `это страница, которую никто не найдёт. Либо дай на неё ссылку, либо сделай ` +
      `редирект, либо подними потолок ЭТИМ же коммитом с причиной: ${orphans.join(', ')}`,
    ).toBeLessThanOrEqual(CEILING.pages);
  }, 200_000);

  it('компонентов без импортёра не больше потолка', () => {
    const { total, orphans } = count('components');
    expect(total).toBeGreaterThan(100);
    expect(
      orphans.length,
      `компонентов без импортёра ${orphans.length} > ${CEILING.components}: ${orphans.join(', ')}`,
    ).toBeLessThanOrEqual(CEILING.components);
  }, 200_000);
});
