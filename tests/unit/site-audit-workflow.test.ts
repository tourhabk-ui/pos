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

  it('маркер называет домен без схемы', () => {
    expect(MARKER.host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    expect(MARKER.maxPages ?? 60).toBeLessThanOrEqual(200);
  });
});
