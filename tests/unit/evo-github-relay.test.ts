import { describe, it, expect, afterEach } from 'vitest';
import { githubUrl } from '@/lib/agents/evo/github-fetch';

const API = 'https://api.github.com/repos/tourhabk-ui/pos/git/trees/main?recursive=1';
const RAW = 'https://raw.githubusercontent.com/tourhabk-ui/pos/main/lib/kuzmich/core.ts';

describe('githubUrl — переписывание GitHub-URL на релей', () => {
  afterEach(() => {
    delete process.env.GITHUB_PROXY_BASE;
  });

  it('без GITHUB_PROXY_BASE — URL как есть (dev/CI, прежнее поведение)', () => {
    delete process.env.GITHUB_PROXY_BASE;
    expect(githubUrl(API)).toBe(API);
    expect(githubUrl(RAW)).toBe(RAW);
  });

  it('api.github.com → <base>/gh-api/...', () => {
    process.env.GITHUB_PROXY_BASE = 'https://vedar-ai-relay.tourhabk.workers.dev';
    expect(githubUrl(API)).toBe(
      'https://vedar-ai-relay.tourhabk.workers.dev/gh-api/repos/tourhabk-ui/pos/git/trees/main?recursive=1',
    );
  });

  it('raw.githubusercontent.com → <base>/gh-raw/...', () => {
    process.env.GITHUB_PROXY_BASE = 'https://vedar-ai-relay.tourhabk.workers.dev';
    expect(githubUrl(RAW)).toBe(
      'https://vedar-ai-relay.tourhabk.workers.dev/gh-raw/tourhabk-ui/pos/main/lib/kuzmich/core.ts',
    );
  });

  it('хвостовой слэш в базе не даёт двойного //', () => {
    process.env.GITHUB_PROXY_BASE = 'https://vedar-ai-relay.tourhabk.workers.dev/';
    expect(githubUrl(RAW)).toBe(
      'https://vedar-ai-relay.tourhabk.workers.dev/gh-raw/tourhabk-ui/pos/main/lib/kuzmich/core.ts',
    );
  });

  it('не-GitHub URL не трогаем даже при заданной базе', () => {
    process.env.GITHUB_PROXY_BASE = 'https://vedar-ai-relay.tourhabk.workers.dev';
    const other = 'https://openrouter.ai/api/v1/models';
    expect(githubUrl(other)).toBe(other);
  });

  it('хост-самозванец не проходит как github (точное совпадение, не подстрока)', () => {
    process.env.GITHUB_PROXY_BASE = 'https://vedar-ai-relay.tourhabk.workers.dev';
    // startsWith("https://api.github.com") дал бы ложное срабатывание — URL.host не даёт.
    const spoof = 'https://api.github.com.evil.example/repos/x';
    expect(githubUrl(spoof)).toBe(spoof);
    const spoof2 = 'https://raw.githubusercontent.com.evil.example/x';
    expect(githubUrl(spoof2)).toBe(spoof2);
  });

  it('битый URL не роняет и не переписывается', () => {
    process.env.GITHUB_PROXY_BASE = 'https://vedar-ai-relay.tourhabk.workers.dev';
    expect(githubUrl('not a url')).toBe('not a url');
  });
});
