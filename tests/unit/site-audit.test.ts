/**
 * Проверка сайтов операторов: «не смогли посмотреть» — не «безопасно».
 *
 * Решение владельца 19.08 (issue #1275). Платформа ручается за оператора, и
 * его сайт — часть ручательства. Инструмент, который на недоступном сайте
 * рисует зелёное, опаснее отсутствия инструмента: он даёт основание верить
 * там, где оснований нет.
 *
 * Отдельно закреплена ГРАНИЦА: только то, что видит обычный посетитель.
 * Перебор, фаззинг и эксплуатация требуют разрешения владельца сайта, а не
 * решения владельца платформы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  auditSnapshot, summarize, isAuditableUrl, SENSITIVE_PATHS, REQUEST_BUDGET,
  CERT_WARN_DAYS, USER_AGENT, type SiteSnapshot,
} from '@/lib/security/site-audit';

const PROBE = readFileSync(join(process.cwd(), 'lib/security/site-probe.ts'), 'utf-8');
const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/operator-site-audit/route.ts'), 'utf-8');

const healthy: SiteSnapshot = {
  finalUrl: 'https://example-operator.ru/',
  status: 200,
  headers: {
    'strict-transport-security': 'max-age=63072000',
    'content-security-policy': "default-src 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  },
  html: '<html><img src="https://example-operator.ru/a.jpg"></html>',
  certDaysLeft: 200,
  httpRedirectsToHttps: true,
  exposedPaths: [],
  pathsProbed: true,
  failure: null,
};

describe('недоступный сайт — не «безопасный»', () => {
  const dead: SiteSnapshot = {
    finalUrl: null, status: null, headers: {}, html: null, certDaysLeft: null,
    httpRedirectsToHttps: null, exposedPaths: [], pathsProbed: false,
    failure: 'нет ответа: имя не разрешилось',
  };

  it('итог по мёртвому сайту не «ok»', () => {
    const s = summarize(auditSnapshot(dead));
    expect(s.verdict).not.toBe('ok');
  });

  it('каждая непроверенная проверка помечена «не знаю», а не молчит', () => {
    const checks = auditSnapshot(dead);
    // Молчание читалось бы как «нарушений не найдено» — а мы не смотрели.
    for (const id of ['https', 'cert', 'hsts', 'csp', 'mixed-content', 'exposed-paths']) {
      const c = checks.find((x) => x.id === id);
      expect(c, `проверка ${id} пропала из отчёта`).toBeDefined();
      expect(c?.outcome).toBe('unknown');
    }
  });

  it('недоступность названа причиной, а не пустотой', () => {
    const reach = auditSnapshot(dead).find((c) => c.id === 'reachable');
    expect(reach?.outcome).toBe('bad');
    expect(reach?.detail).toMatch(/имя не разрешилось/);
  });

  it('ни одного определённого ответа — итог «не знаю», а не «хорошо»', () => {
    const onlyUnknown = auditSnapshot(dead).filter((c) => c.outcome === 'unknown');
    expect(summarize(onlyUnknown).verdict).toBe('unknown');
  });
});

describe('здоровый сайт проходит', () => {
  it('без замечаний — итог ok', () => {
    const s = summarize(auditSnapshot(healthy));
    expect(s.verdict).toBe('ok');
    expect(s.badCount).toBe(0);
  });

  it('заголовки, сертификат и пути разобраны', () => {
    const checks = auditSnapshot(healthy);
    expect(checks.find((c) => c.id === 'hsts')?.outcome).toBe('ok');
    expect(checks.find((c) => c.id === 'cert')?.outcome).toBe('ok');
    expect(checks.find((c) => c.id === 'exposed-paths')?.outcome).toBe('ok');
  });
});

describe('находки называются по существу', () => {
  it('истёкший сертификат — высокая важность', () => {
    const c = auditSnapshot({ ...healthy, certDaysLeft: -3 }).find((x) => x.id === 'cert');
    expect(c?.outcome).toBe('bad');
    expect(c?.severity).toBe('high');
    expect(c?.detail).toMatch(/истёк 3 сут назад/);
  });

  it('скоро истекающий — предупреждение, а не тревога', () => {
    const c = auditSnapshot({ ...healthy, certDaysLeft: CERT_WARN_DAYS - 1 }).find((x) => x.id === 'cert');
    expect(c?.outcome).toBe('bad');
    expect(c?.severity).toBe('medium');
  });

  it('сайт без HTTPS — высокая важность', () => {
    const c = auditSnapshot({ ...healthy, finalUrl: 'http://example-operator.ru/' })
      .find((x) => x.id === 'https');
    expect(c?.outcome).toBe('bad');
    expect(c?.severity).toBe('high');
  });

  it('открытый .env — высокая важность и назван поимённо', () => {
    const c = auditSnapshot({ ...healthy, exposedPaths: ['/.env'] }).find((x) => x.id === 'exposed-paths');
    expect(c?.outcome).toBe('bad');
    expect(c?.severity).toBe('high');
    expect(c?.detail).toContain('/.env');
  });

  it('смешанный контент виден', () => {
    const c = auditSnapshot({ ...healthy, html: '<img src="http://cdn.example.com/a.jpg">' })
      .find((x) => x.id === 'mixed-content');
    expect(c?.outcome).toBe('bad');
  });

  it('версия ПО в заголовке — находка, а имя без версии — нет', () => {
    const withVer = auditSnapshot({ ...healthy, headers: { ...healthy.headers, server: 'nginx/1.18.0' } })
      .find((x) => x.id === 'version-disclosure');
    expect(withVer?.outcome).toBe('bad');
    // «nginx» без цифр эксплойт не подбирает — это не находка.
    const noVer = auditSnapshot({ ...healthy, headers: { ...healthy.headers, server: 'nginx' } })
      .find((x) => x.id === 'version-disclosure');
    expect(noVer?.outcome).toBe('ok');
  });

  it('пути не проверялись — «не знаю», а не «закрыты»', () => {
    const c = auditSnapshot({ ...healthy, pathsProbed: false }).find((x) => x.id === 'exposed-paths');
    expect(c?.outcome).toBe('unknown');
  });
});

describe('граница: оценка, а не вторжение', () => {
  it('служебные пути только запрашиваются, но не читаются', () => {
    // HEAD, а не GET: нам нужен код ответа, содержимое чужого секрета — нет.
    expect(PROBE).toMatch(/SENSITIVE_PATHS/);
    expect(PROBE).toMatch(/get\(new URL\(p, finalUrl\)\.toString\(\), 'HEAD'\)/);
    expect(PROBE).toMatch(/НЕ читаем/);
  });

  it('в проверке нет перебора, фаззинга и эксплуатации', () => {
    const forbidden = /brute|fuzz|payload|sqlmap|exploit|password.*list|wordlist/i;
    expect(PROBE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(forbidden);
  });

  it('бюджет запросов на сайт ограничен и соблюдается', () => {
    expect(REQUEST_BUDGET).toBeLessThanOrEqual(20);
    expect(PROBE).toMatch(/spent >= REQUEST_BUDGET/);
  });

  it('мы представляемся своим именем — оператор опознает нас в логах', () => {
    expect(USER_AGENT).toMatch(/vedarai\.ru/);
    expect(PROBE).toMatch(/'User-Agent': USER_AGENT/);
  });

  it('отказавшийся оператор не проверяется', () => {
    expect(ROUTE).toMatch(/site_audit_consent <> 'declined'/);
  });

  it('очередь обходится целиком, а не крутится по первым', () => {
    // NULLS FIRST: ни разу не проверенный идёт впереди, а не выпадает.
    expect(ROUTE).toMatch(/ORDER BY a\.last_at ASC NULLS FIRST/);
  });
});

describe('адрес проверяется до захода', () => {
  it('внешние http(s) — годятся', () => {
    expect(isAuditableUrl('https://kamchatka-tour.ru')).toBe(true);
    expect(isAuditableUrl('http://example.com/path')).toBe(true);
  });

  it('внутренние и свои — нет', () => {
    // Кривая запись в БД не должна отправлять нас по внутренней сети.
    expect(isAuditableUrl('http://localhost:3000')).toBe(false);
    expect(isAuditableUrl('http://192.168.1.1')).toBe(false);
    expect(isAuditableUrl('https://api.internal')).toBe(false);
    expect(isAuditableUrl('https://vedarai.ru')).toBe(false);
    expect(isAuditableUrl('file:///etc/passwd')).toBe(false);
    expect(isAuditableUrl('')).toBe(false);
    expect(isAuditableUrl(null)).toBe(false);
  });

  it('негодный адрес записывается как «не знаю», а не пропускается молча', () => {
    expect(ROUTE).toMatch(/адрес не годится для проверки/);
  });
});

describe('список служебных путей осмыслен', () => {
  it('короткий и состоит из файлов, утечка которых сама по себе происшествие', () => {
    expect(SENSITIVE_PATHS.length).toBeLessThanOrEqual(10);
    expect(SENSITIVE_PATHS).toContain('/.env');
    expect(SENSITIVE_PATHS).toContain('/.git/config');
  });
});
