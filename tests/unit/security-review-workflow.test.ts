/**
 * Security Review workflow (evo #795): AI-ревью диффа PR через официальный
 * экшен Anthropic — дополняет CodeQL. Страж: корректный триггер, гейт по
 * ключу (без секрета не падает), совещательный режим (комментарии на PR).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const wf = readFileSync('.github/workflows/security-review.yml', 'utf8');

describe('security-review workflow', () => {
  it('использует официальный экшен Anthropic', () => {
    expect(wf).toMatch(/anthropics\/claude-code-security-review/);
    expect(wf).toMatch(/claude-api-key:\s*\$\{\{\s*secrets\.CLAUDE_API_KEY/);
  });

  it('триггер pull_request (не pull_request_target — форки не получают секрет)', () => {
    expect(wf).toMatch(/on:\s*[\s\S]*pull_request:/);
    expect(wf).not.toMatch(/pull_request_target/);
  });

  it('гейт по наличию ключа — без секрета шаг пропускается, не падает', () => {
    expect(wf).toMatch(/env\.CLAUDE_API_KEY != ''/);
    expect(wf).toMatch(/env\.CLAUDE_API_KEY == ''/);
  });

  it('постит комментарии на PR (совещательный режим)', () => {
    expect(wf).toMatch(/comment-pr:\s*true/);
  });

  it('минимально необходимые права', () => {
    expect(wf).toMatch(/pull-requests:\s*write/);
    expect(wf).toMatch(/contents:\s*read/);
  });
});
