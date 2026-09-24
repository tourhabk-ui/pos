// @vitest-environment node
/**
 * Выкатка не гасит сама себя (24.09).
 *
 * Timeweb запускает новую сборку, ОСТАНАВЛИВАЯ идущую. Каждый коммит
 * собирался дважды — вебхуком сразу и просьбой deploy.yml через 15 минут
 * после CI, — и просьба про старый коммит гасила сборку более нового.
 * 24.09: восемь сборок подряд в статусе stopped, прод три часа на старом
 * образе. Держится: просьба уходит, только если main не ушёл вперёд и
 * Timeweb не собирает (не собрал) коммит, содержащий наш.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf-8');
const step = WF.slice(WF.indexOf('- name: Ask Timeweb to build this commit'), WF.indexOf('- name: Verify deploy reached production'));

describe('просьба о сборке не останавливает чужую', () => {
  it('main ушёл вперёд — просьбы нет', () => {
    expect(step).toMatch(/git merge-base --is-ancestor "\$EXPECTED_SHA" "\$HEAD_MAIN"/);
    const skip = step.indexOf('сборку не просим');
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(step.indexOf('ask "https://api.timeweb.cloud/api/v1/apps/$APP_ID/deploy"'));
  });

  it('Timeweb уже собирает коммит, содержащий наш, — просьбы нет', () => {
    expect(step).toMatch(/deploys\?limit=5/);
    expect(step).toMatch(/\.status == "building"/);
    expect(step).toMatch(/вторую сборку не просим/);
  });
});
