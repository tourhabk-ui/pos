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
  auditSnapshot, summarize, isAuditableUrl, isPrivateAddress, SENSITIVE_PATHS,
  REQUEST_BUDGET, CERT_WARN_DAYS, USER_AGENT, type SiteSnapshot,
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
  certTrusted: true,
  certUntrustedReason: null,
  httpRedirectsToHttps: true,
  exposedPaths: [],
  pathsProbed: true,
  failure: null,
};

describe('недоступный сайт — не «безопасный»', () => {
  const dead: SiteSnapshot = {
    finalUrl: null, status: null, headers: {}, html: null, certDaysLeft: null,
    certTrusted: null, certUntrustedReason: null,
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
    // NULLS FIRST: у ни разу не проверенного записи нет вовсе, и без этого он
    // ушёл бы в конец очереди навсегда.
    expect(ROUTE).toMatch(/\) ASC NULLS FIRST/);
    expect(ROUTE).toMatch(/SELECT MAX\(sa\.checked_at\)/);
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

/**
 * SSRF в инструменте безопасности.
 *
 * CodeQL назвал это верно на первой же редакции: адрес берётся из БД, а запрос
 * шёл с `redirect: 'follow'`. Чужой сайт вправе ответить
 * `302 Location: http://169.254.169.254/` — это метаданные облака, ради
 * которых SSRF обычно и затевают. Проверки ИСХОДНОГО адреса от этого не
 * спасает: небезопасен каждый следующий переход.
 */
describe('проверять чужие сайты, не став оружием', () => {
  it('частные и служебные адреса опознаются, включая IPv6', () => {
    for (const a of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254',            // метаданные облака
      '100.64.0.1',                 // CGNAT
      '::1', 'fd00::1', 'fe80::1', '::ffff:169.254.169.254',
    ]) {
      expect(isPrivateAddress(a), `${a} должен считаться частным`).toBe(true);
    }
  });

  it('публичные адреса частными не считаются', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(a), `${a} публичный`).toBe(false);
    }
  });

  it('перенаправления идут вручную и судятся на каждом шаге', () => {
    // `follow` отдаёт решение о следующем адресе чужому серверу.
    //
    // Запрет проверяется по КОДУ без комментариев: пояснение к правке цитирует
    // запрещённое, и сторож ловил сам себя — третий раз за день на одном и том
    // же (reviews-two-subjects, flagship-resolver, теперь этот).
    const code = PROBE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).toMatch(/redirect: 'manual'/);
    expect(code).not.toMatch(/redirect: 'follow'/);
    expect(PROBE).toMatch(/for \(let hop = 0; hop <= MAX_HOPS/);
    expect(PROBE).toMatch(/if \(!isAuditableUrl\(current\)\) return null/);
  });

  it('имя проверяется по тому, куда оно разрешается', () => {
    // `internal.example.com` — внешнее имя, а разрешается в 10.0.0.5.
    expect(PROBE).toMatch(/resolvesPublic/);
    expect(PROBE).toMatch(/addrs\.every\(\(a\) => !isPrivateAddress\(a\.address\)\)/);
  });

  it('не разрешилось — отказ, а не пропуск', () => {
    // «Не знаю, куда ведёт» безопаснее «наверное, можно».
    expect(PROBE).toMatch(/catch \{\s*return false;\s*\}/);
  });

  it('цепочка перенаправлений ограничена', () => {
    expect(PROBE).toMatch(/MAX_HOPS = \d/);
  });

  it('адрес из БД с частным хостом отбрасывается до запроса', () => {
    expect(isAuditableUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAuditableUrl('http://[::1]:8080/')).toBe(false);
    expect(isAuditableUrl('https://10.0.0.5/')).toBe(false);
  });
});

/**
 * Проверка без поверхности ничего не говорит никому.
 *
 * Крон, таблица и правила были написаны, а смотреть результаты было негде:
 * отчёты ложились бы в базу каждую ночь, и первым, кто их увидит, был бы psql.
 * Это тот же дефект, что и весь остальной день, только с другой стороны — не
 * «зелёное вместо неизвестного», а «известное, о котором не сказали».
 */
describe('отчёты видны владельцу, а не только базе', () => {
  const API = readFileSync(join(process.cwd(), 'app/api/admin/operator-sites/route.ts'), 'utf-8');
  const UI = readFileSync(join(process.cwd(), 'app/hub/admin/operator-sites/_OperatorSitesClient.tsx'), 'utf-8');

  it('экран закрыт админской проверкой', () => {
    expect(API).toMatch(/requireAdmin/);
  });

  it('ни разу не проверенный оператор виден, а не выпадает из списка', () => {
    // Выпав из выборки, он выглядел бы как отсутствующий, а не как неизвестный.
    expect(API).toMatch(/LEFT JOIN LATERAL/);
    expect(API).toMatch(/verdict: r\.checked_at \? r\.verdict : 'never'/);
  });

  it('четыре состояния различимы на экране, включая «не знаю»', () => {
    for (const s of ['есть замечания', 'проверить не смогли', 'ни разу не проверяли', 'замечаний нет']) {
      expect(UI, `состояние «${s}» не показано`).toContain(s);
    }
  });

  it('отказ загрузки не выдаётся за пустой список', () => {
    expect(UI).toMatch(/Отчёты не загрузились/);
    expect(UI).toMatch(/состояние сайтов сейчас неизвестно/);
  });

  it('пустой список назван честно, а не «всё в порядке»', () => {
    expect(UI).toMatch(/Проверять нечего — и это не то же самое/);
  });

  it('внимание идёт первым: сначала замечания, потом непроверенное', () => {
    // Список, отсортированный по имени, читают сверху и бросают на середине.
    expect(API).toMatch(/WHEN 'issues' THEN 1 WHEN 'unknown' THEN 2/);
  });

  it('сводка считается на сервере — два счёта одного разъезжаются', () => {
    expect(API).toMatch(/summary: \{/);
  });

  it('цвета только из токенов дизайн-системы', () => {
    // CLAUDE.md §2: хардкод hex запрещён.
    const hex = UI.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hex).toEqual([]);
    expect(UI).toMatch(/var\(--danger\)/);
    expect(UI).toMatch(/var\(--warning\)/);
  });

  it('ссылка на чужой сайт не передаёт нас источником', () => {
    expect(UI).toMatch(/rel="noopener noreferrer nofollow"/);
  });
});

describe('срок сертификата и доверие к нему — разные вопросы', () => {
  it('самоподписанный с дальней датой НЕ «ok»', () => {
    // Ровно этот случай проходил зелёным: rejectUnauthorized выключен,
    // getPeerCertificate отдаёт присланное, дата дальняя — «действует ещё
    // 200 сут». Браузер туриста при этом показал бы предупреждение.
    const c = auditSnapshot({
      ...healthy, certDaysLeft: 200, certTrusted: false,
      certUntrustedReason: 'SELF_SIGNED_CERT_IN_CHAIN',
    }).find((x) => x.id === 'cert');
    expect(c?.outcome).toBe('bad');
    expect(c?.detail).toContain('SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('доверие не выяснено — это «не знаю», а не «ok»', () => {
    const c = auditSnapshot({ ...healthy, certDaysLeft: 200, certTrusted: null })
      .find((x) => x.id === 'cert');
    expect(c?.outcome).toBe('unknown');
  });

  it('доверенный и свежий — по-прежнему «ok»', () => {
    const c = auditSnapshot(healthy).find((x) => x.id === 'cert');
    expect(c?.outcome).toBe('ok');
  });

  it('проверка доверия берётся у узла TLS, а не из даты', () => {
    // socket.authorized знает результат сверки цепочки и имени; дата в
    // valid_to про это не говорит ничего.
    expect(PROBE).toMatch(/socket\.authorized/);
    expect(PROBE).toMatch(/authorizationError/);
    expect(PROBE, 'выключение проверки обязано остаться осознанным и объяснённым')
      .toMatch(/rejectUnauthorized: false/);
  });
});
