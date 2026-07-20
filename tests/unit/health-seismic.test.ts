/**
 * Монитор-над-монитором: /api/cron/health следит за свежестью сейсмо-ингеста.
 * Тестируем чистую логику seismicIssueFromAge — молчание монитора недопустимо.
 */

import { describe, it, expect } from 'vitest';
import { seismicIssueFromAge } from '@/app/api/cron/health/route';

describe('seismicIssueFromAge', () => {
  it('свежий heartbeat (< порога) → нет проблемы', () => {
    expect(seismicIssueFromAge(4)).toBeNull();
    expect(seismicIssueFromAge(14.9, 15)).toBeNull();
  });

  it('устаревший heartbeat (> порога) → crit с возрастом', () => {
    const issue = seismicIssueFromAge(81);
    expect(issue?.level).toBe('crit');
    expect(issue?.text).toContain('81');
  });

  it('ни разу не отработал (null) → crit', () => {
    const issue = seismicIssueFromAge(null);
    expect(issue?.level).toBe('crit');
    expect(issue?.text).toContain('ни разу');
  });

  it('порог настраиваемый', () => {
    expect(seismicIssueFromAge(10, 5)?.level).toBe('crit');
    expect(seismicIssueFromAge(10, 20)).toBeNull();
  });
});
