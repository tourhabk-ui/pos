/**
 * Манифест контроля выхода держится связкой, а не текстом (CLAUDE.md §4:
 * описание живёт дольше кода, если его никто не сверяет).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MANIFEST = read('docs/safety/WATCH_MANIFEST.md');

describe('манифест контроля выхода', () => {
  it('на месте, и CLAUDE.md на него ссылается', () => {
    expect(read('CLAUDE.md')).toContain('docs/safety/WATCH_MANIFEST.md');
  });

  it('каждый путь из манифеста существует', () => {
    const paths = [...MANIFEST.matchAll(/`((?:app|lib|tests)\/[^`\s]+?)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) {
      const clean = p.replace(/\/$/, '');
      const candidates = [clean, `${clean}.ts`, `${clean}/route.ts`];
      expect(candidates.some((c) => existsSync(join(ROOT, c))), `манифест ссылается на несуществующий ${p}`).toBe(true);
    }
  });

  it('сторож невозвращения один (правило 1)', () => {
    const crons = readdirSync(join(ROOT, 'app/api/cron'));
    expect(crons).toContain('checkin-watchdog');
    expect(crons, 'второй судья того же факта вернулся').not.toContain('route-escalation');
    // Никакой другой крон не пишет журнал доставки тревог о невозвращении.
    const writers = crons.filter((c) => {
      const f = join(ROOT, 'app/api/cron', c, 'route.ts');
      return existsSync(f) && /INSERT INTO route_registration_notifications/.test(readFileSync(f, 'utf-8'));
    });
    expect(writers).toEqual(['checkin-watchdog']);
  });

  it('срок регистрации — только через kamchatkaWallTime (правило 2)', () => {
    expect(read('app/api/safety/register/route.ts')).toContain('kamchatkaWallTime(');
  });

  it('невыполненные правила перечислены открыто', () => {
    expect(MANIFEST).toContain('## Где правило пока не выполнено');
  });
});
