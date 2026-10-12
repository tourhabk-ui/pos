/**
 * Сторож на сам токен-гейт.
 *
 * Гейт (`scripts/design-token-gate.mjs`) рендерит страницы и сверяет палитру с
 * токенами `app/globals.css`; исключения живут в allowlist и не красят прогон.
 * Ровно поэтому у него несколько способов тихо выродиться:
 *  · allowlist разрастается записями без причины — и «исключение» перестаёт
 *    отличаться от «забыли»;
 *  · токены перестают вычитываться из globals.css (переезд файла, свой список
 *    в скрипте) — тогда нарушением становится всё или ничего;
 *  · браузер ставится не той версией Playwright, что бандлит извлекатель —
 *    дрейф 17.08–12.10: 67 красных прогонов подряд с диагнозом «приложение
 *    недоступно» при живом приложении (#2378). Теперь пин один (в скрипте),
 *    браузер ставит сам dembrandt, а недоступность — измеренный факт.
 * Здесь проверяется то, что можно проверить без запущенного приложения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const GATE = read('scripts/design-token-gate.mjs');
const ALLOWLIST = JSON.parse(read('scripts/design-token-gate.allowlist.json')) as {
  colors: Record<string, string>;
};
const WORKFLOW = read('.github/workflows/design-token-gate.yml');

describe('токен-гейт: источник истины — globals.css', () => {
  it('токены читаются из globals.css, а не перечислены в скрипте', () => {
    expect(GATE).toMatch(/app\/globals\.css/);
    // Свой список hex в скрипте означал бы вторую дизайн-систему.
    const literals = GATE.match(/'#[0-9a-fA-F]{6}'/g) ?? [];
    const neutral = new Set(["'#ffffff'", "'#000000'"]);
    expect(literals.filter((h) => !neutral.has(h.toLowerCase()))).toEqual([]);
  });

  it('нарушение красит прогон, а не только печатается', () => {
    expect(GATE).toMatch(/process\.exit\(1\)/);
  });
});

describe('три исхода, не два (§4.0)', () => {
  it('недоступное приложение — не зелёный вердикт и не вина браузера: проба адреса до запуска браузера', () => {
    // Молча зелёный гейт хуже отсутствующего: он создаёт ложную уверенность.
    expect(GATE).toMatch(/async function probeApp\(\)/);
    expect(GATE).toMatch(/приложение недоступно по BASE_URL — браузер не запускался/);
    // Проба стоит ДО извлечения: браузер при мёртвом адресе не запускается.
    expect(GATE.indexOf('await probeApp()')).toBeLessThan(GATE.indexOf('data = extract()'));
    // Поведением: закрытый порт → код 2 и названная причина, без запуска dembrandt.
    const run = spawnSync(process.execPath, ['scripts/design-token-gate.mjs'], {
      cwd: ROOT,
      env: { ...process.env, BASE_URL: 'http://127.0.0.1:9', GATE_PATHS: '/sos' },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(run.status).toBe(2);
    const lines = run.stdout.trim().split('\n').map((l) => JSON.parse(l) as { stage: string; message: string; url?: string });
    expect(lines.at(-1)).toMatchObject({ stage: 'ERROR', message: expect.stringContaining('приложение недоступно'), url: 'http://127.0.0.1:9/sos' });
    expect(run.stdout).not.toMatch(/палитра/);
  });

  it('отказ браузера или извлекателя при живом приложении назван отдельно, с подсказкой про браузер', () => {
    expect(GATE).toMatch(/браузер или извлекатель не сработали при живом приложении/);
    expect(GATE).toMatch(/hint: 'поставить браузер под закреплённый dembrandt: node scripts\/design-token-gate\.mjs --install-browser'/);
  });

  it('пустая палитра — отказ (код 2), а не «нарушений нет»', () => {
    expect(GATE).toMatch(/if \(palette\.length === 0\) \{[\s\S]{0,500}?process\.exit\(2\);/);
    expect(GATE).toMatch(/палитра пуста/);
  });
});

describe('одна версия на всё: пин dembrandt и браузер от него же', () => {
  it('версия извлекателя закреплена точно, без диапазона', () => {
    expect(GATE).toMatch(/const DEMBRANDT = 'dembrandt@\d+\.\d+\.\d+';/);
    expect(GATE).not.toMatch(/dembrandt@[\^~]/);
  });

  it('браузер ставит сам dembrandt того же пина; своей версии Playwright у workflow нет', () => {
    expect(GATE).toMatch(/\['--yes', DEMBRANDT, 'install-browser', '--with-deps', 'chromium'\]/);
    expect(GATE).toMatch(/process\.argv\.includes\('--install-browser'\)/);
    expect(WORKFLOW).toMatch(/run: node scripts\/design-token-gate\.mjs --install-browser/);
    // Вторая версия Playwright в workflow — ровно тот дрейф, что держал гейт красным.
    // Судятся шаги, а не комментарии: комментарий как раз и рассказывает про 1.62.1.
    const steps = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(steps).not.toMatch(/playwright@\d|playwright install|playwright-core/);
    // Сначала браузер, потом гейт.
    expect(WORKFLOW.indexOf('--install-browser')).toBeLessThan(WORKFLOW.lastIndexOf('run: node scripts/design-token-gate.mjs'));
  });

  it('workflow зовёт скрипт по проду ночью, рукой и маркером', () => {
    expect(WORKFLOW).toMatch(/run: node scripts\/design-token-gate\.mjs\s*$/m);
    expect(WORKFLOW).toMatch(/schedule:/);
    expect(WORKFLOW).toMatch(/workflow_dispatch:/);
    // Маркер — единственный запуск, доступный из агентной сессии (dispatch закрыт 403).
    expect(WORKFLOW).toMatch(/paths:\n\s+- '\.github\/triggers\/design-token-gate\.json'/);
    const marker = JSON.parse(read('.github/triggers/design-token-gate.json')) as { run: number; run1_reason: string };
    expect(marker.run).toBeGreaterThanOrEqual(1);
    expect(marker.run1_reason.length).toBeGreaterThan(40);
  });

  it('локальный запуск есть в npm-скриптах', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['design:tokens']).toMatch(/design-token-gate\.mjs/);
  });
});

describe('фиолетовый — токен --purple, не хардкод (решение владельца 12.10)', () => {
  it('токен есть во всех трёх блоках globals.css, им пользуется карточка SOS, он описан в CLAUDE.md и DESIGN_SYSTEM.md', () => {
    const css = read('app/globals.css');
    expect(css.match(/^\s*--purple:\s*#[0-9A-Fa-f]{6};/gm)?.length).toBe(3);
    // Судится код, не комментарий: шапка компонента как раз рассказывает про прежний #a78bfa.
    const card = read('components/safety/SatelliteDictationCard.tsx').replace(/^\s*\/\/.*$/gm, '');
    expect(card).not.toMatch(/#a78bfa/i);
    expect(card.match(/var\(--purple\)/g)?.length).toBeGreaterThanOrEqual(1);
    // Без data-theme на корне: токен-гейт CI (scripts/token-gate.mjs) красит любое
    // переопределение --accent/--danger на элементе /sos как теневое.
    expect(card).not.toMatch(/data-theme=/);
    expect(read('CLAUDE.md')).toMatch(/^\| `--purple` \| `#7C3AED` \| `#A855F7` \|/m);
    expect(read('.claude/DESIGN_SYSTEM.md')).toMatch(/^\| `--purple` \|/m);
    // Узаконенный цвет не живёт в исключениях гейта.
    expect(ALLOWLIST.colors).not.toHaveProperty('#a78bfa');
  });
});

describe('allowlist: исключение с причиной, а не свалка', () => {
  it('у каждого цвета есть внятная причина', () => {
    const entries = Object.entries(ALLOWLIST.colors);
    expect(entries.length).toBeGreaterThan(0);
    for (const [color, reason] of entries) {
      expect(color, `${color}: не нормализованный hex`).toMatch(/^#[0-9a-f]{6}$/);
      expect(reason.trim().length, `${color}: причина пустая`).toBeGreaterThan(20);
    }
  });

  it('в исключения не попал документированный токен', () => {
    // Токен в allowlist — признак того, что список перестали читать.
    const css = read('app/globals.css');
    const tokens = new Set((css.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()));
    for (const color of Object.keys(ALLOWLIST.colors)) {
      expect(tokens.has(color), `${color} есть в globals.css — исключение лишнее`).toBe(false);
    }
  });
});
