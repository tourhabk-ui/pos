/**
 * Разведчик читает гео-закрытые источники через реле вне РФ — честно.
 *
 * 03.09: сейсмо-реле (infra/safety-relay) замером доказало, что с края
 * Cloudflare читается t.me, закрытый для прода. Тот же воркер получил
 * маршрут /fetch, а разведчик — фолбэк на него. Сторож держит контракт:
 *
 *   - реле — фолбэк после отказа, похожего на блокировку, а не путь по
 *     умолчанию; 404 на реле не уходит (ленты нет — реле её не найдёт);
 *   - без SCOUT_RELAY_BASE + CRON_SECRET реле нет;
 *   - путь чтения записан в отчёт (`via`), секрет — заголовком;
 *   - у воркера /fetch закрыт секретом и белым списком хостов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  relayBase, relayConfigured, relayFetchUrl, relayHeaders, shouldFallbackToRelay,
} from '@/lib/agents/scout-relay';
import { buildSourceReport } from '@/lib/services/scout/source-health';

const ROOT = process.cwd();
const DIGEST = readFileSync(join(ROOT, 'lib/agents/scout-digest.ts'), 'utf-8');
const WORKER = readFileSync(join(ROOT, 'infra/safety-relay/worker.js'), 'utf-8');
const TOML = readFileSync(join(ROOT, 'infra/safety-relay/wrangler.toml'), 'utf-8');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/safety-relay-deploy.yml'), 'utf-8');

describe('когда идти на реле', () => {
  it('сетевой отказ и гео-коды — да', () => {
    expect(shouldFallbackToRelay({ status: null })).toBe(true);
    expect(shouldFallbackToRelay({ status: 403 })).toBe(true);
    expect(shouldFallbackToRelay({ status: 451 })).toBe(true);
    expect(shouldFallbackToRelay({ status: 429 })).toBe(true);
    expect(shouldFallbackToRelay({ status: 502 })).toBe(true);
  });

  it('404/410 — нет: ленты нет, реле её не найдёт и замаскировало бы мёртвый фид', () => {
    expect(shouldFallbackToRelay({ status: 404 })).toBe(false);
    expect(shouldFallbackToRelay({ status: 410 })).toBe(false);
    expect(shouldFallbackToRelay({ status: 401 })).toBe(false);
  });
});

describe('настройка реле', () => {
  it('без адреса или без секрета реле не настроено', () => {
    expect(relayConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(relayConfigured({ SCOUT_RELAY_BASE: 'https://r.example' } as NodeJS.ProcessEnv)).toBe(false);
    expect(relayConfigured({ CRON_SECRET: 's' } as NodeJS.ProcessEnv)).toBe(false);
    expect(relayConfigured({ SCOUT_RELAY_BASE: 'https://r.example', CRON_SECRET: 's' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('адрес реле: /fetch?url= с кодированием, хвостовой слеш базы снимается', () => {
    expect(relayBase({ SCOUT_RELAY_BASE: 'https://r.example/' } as NodeJS.ProcessEnv)).toBe('https://r.example');
    expect(relayFetchUrl('https://r.example/', 'https://openai.com/news/rss.xml?a=1&b=2'))
      .toBe('https://r.example/fetch?url=https%3A%2F%2Fopenai.com%2Fnews%2Frss.xml%3Fa%3D1%26b%3D2');
  });

  it('секрет уходит заголовком, а не в адресной строке', () => {
    expect(relayHeaders({ CRON_SECRET: 'abc' } as NodeJS.ProcessEnv)).toEqual({ Authorization: 'Bearer abc' });
    expect(DIGEST).not.toMatch(/fetch\?url=[^\n]*secret=/);
  });
});

describe('разведчик: прямой путь первый, путь записан', () => {
  it('fetchSource пробует напрямую, реле — только после отказа и только если настроено', () => {
    expect(DIGEST).toMatch(/const direct = await fetchDirect\(s\.url, s\.label\)/);
    expect(DIGEST).toMatch(/if \(!relayConfigured\(\) \|\| !shouldFallbackToRelay\(\{ status: direct\.status \}\)\)/);
  });

  it('исход называет путь: via direct / relay', () => {
    expect(DIGEST).toMatch(/via: 'direct'/);
    expect(DIGEST).toMatch(/via: 'relay'/);
    // Отказ обеих дорог называет обе причины, а не только реле.
    expect(DIGEST).toMatch(/error: `напрямую: \$\{direct\.error\}; \$\{relayed\.error\}`/);
  });

  it('текст статьи тоже идёт через реле после гео-отказа', () => {
    expect(DIGEST).toMatch(/shouldFallbackToRelay\(\{ status: res\.status \}\)\) && relayConfigured\(\)/);
  });

  it('отчёт здоровья несёт via, когда он есть', () => {
    const report = buildSourceReport(
      [
        { key: 'openai', label: 'OpenAI', status: 'ok', rawItems: 5, inserted: 0, via: 'relay' },
        { key: 'habr_ai', label: 'Habr AI', status: 'ok', rawItems: 5, inserted: 0, via: 'direct' },
        { key: 'safety_layer', label: 'Safety-слой', status: 'ok', rawItems: 3, inserted: 0 },
      ],
      {},
      Date.now(),
    );
    expect(report[0].via).toBe('relay');
    expect(report[1].via).toBe('direct');
    expect(report[2]).not.toHaveProperty('via');
  });
});

describe('воркер: /fetch закрыт секретом и белым списком', () => {
  it('маршрут есть, секрет проверяется, хост сверяется с RELAY_HOSTS', () => {
    expect(WORKER).toMatch(/url\.pathname === '\/fetch'/);
    expect(WORKER).toMatch(/hostAllowed\(target\.hostname, env\.RELAY_HOSTS\)/);
    expect(WORKER).toMatch(/x-relay-upstream-status/);
  });

  it('только https, без белого списка — никому', () => {
    expect(WORKER).toMatch(/u\.protocol === 'https:' \? u : null/);
    // Пустой список → allowed = [] → some() false: реле не читает ничего.
    expect(WORKER).toMatch(/return allowed\.some\(/);
  });

  it('белый список задан в конфиге и держит хосты нынешних фидов', () => {
    const m = /RELAY_HOSTS = "([^"]+)"/.exec(TOML);
    expect(m, 'RELAY_HOSTS нет в wrangler.toml').not.toBeNull();
    const hosts = m![1].split(',');
    for (const h of ['simonwillison.net', 'huggingface.co', 'habr.com', 'openai.com', 'anthropic.com', 't.me']) {
      expect(hosts, `в белом списке нет ${h}`).toContain(h);
    }
  });

  it('перепись кандидатов в воркфлоу не красит прогон', () => {
    expect(WORKFLOW).toMatch(/\/census/);
    expect(WORKFLOW).toMatch(/census_urls/);
  });
});
