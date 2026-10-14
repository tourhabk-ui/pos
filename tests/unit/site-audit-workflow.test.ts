/**
 * Сторож аудита стороннего сайта (site-audit.yml + scripts/site-audit.py).
 *
 * Правила: только чтение (GET/HEAD, никаких записей на сайт), маркер
 * называет домен, итог дублируется в check-run (лог из контейнера агента не
 * читается), а права workflow не шире, чем нужно для этого check-run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const WF = read('.github/workflows/site-audit.yml');
const SCRIPT = read('scripts/site-audit.py');
const MARKER = JSON.parse(read('.github/triggers/site-audit.json')) as { host?: string; maxPages?: number };

describe('site-audit: только чтение', () => {
  it('скрипт ходит только GET и HEAD', () => {
    const methods = [...SCRIPT.matchAll(/method(?:: str)?\s*=\s*'([A-Z]+)'/g)].map(m => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET', 'HEAD']));
    expect(SCRIPT).not.toMatch(/'(POST|PUT|PATCH|DELETE)'/);
  });

  it('скрипт представляется своим именем и делает паузу между запросами', () => {
    expect(SCRIPT).toContain("VedarSiteAudit/1.0; +https://vedarai.ru");
    expect(SCRIPT).toMatch(/time\.sleep\(PAUSE\)/);
  });

  it('у проверки есть исход «не смог»: ни один адрес не ответил — прогон красный', () => {
    expect(SCRIPT).toContain("if all(e['code'] == 0 for e in a['entry'])");
    expect(SCRIPT).toContain('return 1');
  });

  it('workflow: маркер, права только на check-run, итог публикуется всегда', () => {
    expect(WF).toContain(".github/triggers/site-audit.json");
    expect(WF).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*checks: write/);
    expect(WF).not.toMatch(/contents: write|pull-requests: write|actions: write/);
    expect(WF).toContain("python3 scripts/site-audit.py --host");
    expect(WF).toMatch(/name: Publish output as check-run\s*\n\s*if: always\(\)/);
    expect(WF).toContain("'name': 'site-audit'");
    expect(WF).not.toMatch(/\bcron:/);
  });

  it('Lighthouse сохраняет трассу с профилем ЦП — без него горячих функций не назвать', () => {
    // Прогон 11 (14.10): трасса была, профиля в ней нет — категория
    // профилировщика в Lighthouse по умолчанию выключена.
    expect(WF).toMatch(/lighthouse@12[^\n]*\n(?:[^\n]*\\\n)*[^\n]*--save-assets/);
    expect(WF).toMatch(/--additional-trace-categories=[^\s"]*disabled-by-default-v8\.cpu_profiler/);
  });

  it('Lighthouse — три прогона на страницу, в таблицу идёт медиана, а не случайный', () => {
    // Прогоны 13–15 (14.10): главная без правок — производительность 67, 80
    // и 62, TBT 780, 240 и 1 060 мс. Одиночный прогон сравнивал шум с шумом.
    const lhStep = WF.slice(WF.indexOf('name: Lighthouse'), WF.indexOf('name: Сводка'));
    expect(lhStep).toMatch(/for k in 1 2 3; do\s*\n\s*out=\/tmp\/lh-\$n-\$k\.json\s*\n\s*runs\+=\("\$out"\)/);
    // Все три пути — в разбор, и удавшиеся, и нет: не прочитанный прогон
    // скрипт назовёт, а не пропустит молча.
    expect(lhStep).toMatch(/python3 scripts\/site-audit\.py lighthouse-runs "\$url" \/tmp\/lh-details\.md "\$\{runs\[@\]\}"/);
    expect(lhStep).not.toMatch(/scripts\/site-audit\.py lighthouse "\$url"/);
  });

  it('Lighthouse представляется как PageSpeed Insights, и Next отдаёт ему метаданные в <head>', () => {
    // Прогон 14 (14.10): SEO 92 на /map и /catalog — «нет meta description».
    // Строка Lighthouse 12 по умолчанию без «Chrome-Lighthouse», и Next 15.5
    // стримил ему метаданные в <body>, где аудит их не ищет. Googlebot, Яндекс
    // и PSI получают их в <head> — замер обязан смотреть так же.
    const ua = WF.match(/^\s*LH_UA: '([^']+)'/m)?.[1] ?? '';
    expect(ua).toContain('Chrome-Lighthouse');
    expect(ua).toMatch(/Mobile Safari/);
    const cfg = require(join(process.cwd(), 'next.config.js')) as { htmlLimitedBots?: RegExp };
    expect(cfg.htmlLimitedBots?.test(ua), 'с этой строкой Next стримит метаданные в <body>').toBe(true);
    // Строка доходит до самого Lighthouse, а не только объявлена.
    expect(WF).toMatch(/lighthouse@12[^\n]*\n(?:[^\n]*\\\n)*[^\n]*--emulatedUserAgent="\$LH_UA"/);
  });

  it('маркер называет домен без схемы', () => {
    expect(MARKER.host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    expect(MARKER.maxPages ?? 60).toBeLessThanOrEqual(200);
  });

  it('перепись sitemap: маркер в пределах, заголовок бота — только для своего домена', () => {
    const m = MARKER as { host?: string; census?: number; ua?: string };
    expect(m.census ?? 0).toBeLessThanOrEqual(2000);
    expect(['default', 'googlebot', 'yandex']).toContain(m.ua ?? 'default');
    if ((m.ua ?? 'default') !== 'default') expect(m.host).toBe('vedarai.ru');
    // Маркер доходит до скрипта, а длинный отчёт переписи — до своего check-run.
    expect(WF).toMatch(/--sitemap-census "\$CENSUS" --ua "\$UAK" --census-md \/tmp\/site-audit-census\.md/);
    expect(WF).toMatch(/name: Publish census as check-run\s*\n\s*if: always\(\)/);
    expect(WF).toContain("'name': 'site-audit-census'");
  });
});
