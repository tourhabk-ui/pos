/**
 * Красный smoke прода — находка, а не молчание (Эволюция 3.0, п.2;
 * владелец 08.08: «эволюция»).
 *
 * Ночной Playwright-smoke по живому проду существовал, но его падение было
 * просто красным джобом: 07.08 он упал, и это увидел только ручной аудит
 * сессии. Петля замыкается GitHub Issue с меткой evo — тем же стоком, что у
 * руки эволюции (issue-reporter), откуда находки берёт Claude Code.
 *
 * Ключевой принцип: канал репорта НЕ зависит от прода. Если vedarai.ru лёг
 * целиком, POST находки в него не уйдёт — поэтому сток падения живёт на
 * стороне GitHub (gh issue), а не в API платформы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = readFileSync(join(process.cwd(), '.github/workflows/e2e-smoke.yml'), 'utf-8');

describe('Эволюция 3.0, п.2: красный smoke заводит Issue', () => {
  it('шаг репорта существует и срабатывает только на падении', () => {
    expect(WF).toMatch(/if: \$\{\{ failure\(\) \}\}/);
    expect(WF).toMatch(/gh issue create/);
  });

  it('метка evo — тот же сток, что у руки эволюции, и создаётся идемпотентно', () => {
    expect(WF).toMatch(/--label evo/);
    expect(WF).toMatch(/gh label create evo[\s\S]{0,200}--force/);
  });

  it('дедуп: открытая issue дополняется комментарием, вторая не заводится', () => {
    expect(WF).toMatch(/gh issue list .*--state open/);
    expect(WF).toMatch(/gh issue comment/);
  });

  it('в issue есть ссылка на прогон — есть с чего начинать разбор', () => {
    expect(WF).toMatch(/RUN_URL: \$\{\{ github\.server_url \}\}/);
  });

  it('канал репорта не зависит от прода: шаг падения не ходит в vedarai.ru', () => {
    // Упоминание домена в тексте issue — законно; сетевой вызов — нет.
    const failStep = WF.slice(WF.indexOf('Красный smoke'));
    expect(failStep).not.toMatch(/curl[^\n]*vedarai/);
    expect(failStep).not.toMatch(/https:\/\/vedarai\.ru\/api/);
    expect(failStep).not.toMatch(/CRON_SECRET/);
  });

  it('права выданы явно и минимально: issues write, contents read', () => {
    expect(WF).toMatch(/issues: write/);
    expect(WF).toMatch(/contents: read/);
  });
});
