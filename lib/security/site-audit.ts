/**
 * lib/security/site-audit.ts
 *
 * Внешняя поверхность сайта оператора: что видно снаружи любому, кто откроет
 * адрес. Решение владельца 19.08 (issue #1275).
 *
 * ── Граница, за которую эта проверка не выходит ────────────────────────────
 *
 * Здесь только то, что делает обычный посетитель: запрашивает страницу и
 * смотрит, что ответил сервер. Перебора паролей, фаззинга, эксплуатации
 * найденного — нет. Разница не техническая, а правовая: оценку внешней
 * поверхности партнёра платформа вправе делать сама, вторжение — нет, и
 * решается это не нами, а владельцем сайта.
 *
 * Запросов на сайт — не больше REQUEST_BUDGET за прогон, и представляемся мы
 * своим именем в User-Agent: оператор должен уметь опознать нас в своих логах.
 *
 * ── Три исхода у каждой проверки (CLAUDE.md §4.0) ──────────────────────────
 *
 * `ok` — проверено, хорошо. `bad` — проверено, плохо. `unknown` — ПРОВЕРИТЬ НЕ
 * СМОГЛИ. Третий не равен первому: сайт не ответил — это не «безопасно».
 * Именно на такой подмене строится ложное спокойствие: отчёт зелёный, потому
 * что проверка не выполнилась.
 */

export type Outcome = 'ok' | 'bad' | 'unknown';
export type Severity = 'high' | 'medium' | 'low';

export interface CheckResult {
  id: string;
  outcome: Outcome;
  severity: Severity;
  /** Человеку — одной строкой, по-русски. */
  detail: string;
}

/** Что удалось снять с сайта. Любое поле может отсутствовать — это исход. */
export interface SiteSnapshot {
  /** Итоговый адрес после перенаправлений. */
  finalUrl: string | null;
  status: number | null;
  /** Заголовки ответа, имена в нижнем регистре. */
  headers: Record<string, string>;
  /** HTML начальной страницы, обрезанный. */
  html: string | null;
  /** Сколько суток осталось сертификату. null — снять не удалось. */
  certDaysLeft: number | null;
  /**
   * Прошёл ли сертификат проверку цепочки и сверку имени. null — не выяснили.
   * Срок и доверие — разные вопросы: самоподписанный сертификат бывает свежим,
   * а выписанный на чужое имя — действующим. Браузер туриста откажет обоим.
   */
  certTrusted: boolean | null;
  /** Почему не прошёл проверку. null — прошёл или не выясняли. */
  certUntrustedReason: string | null;
  /** Ответил ли http:// перенаправлением на https. null — не проверяли. */
  httpRedirectsToHttps: boolean | null;
  /** Служебные пути, ответившие 200: '/.env', '/.git/config', ... */
  exposedPaths: string[];
  /** Проверяли ли служебные пути вообще. */
  pathsProbed: boolean;
  /** Почему снять не удалось вовсе. */
  failure: string | null;
}

/** Сколько запросов позволено на один сайт за прогон. */
export const REQUEST_BUDGET = 12;

/** Как мы представляемся. Оператор должен опознать нас в своих логах. */
export const USER_AGENT = 'VedarSiteCheck/1.0 (+https://vedarai.ru/security-check)';

/**
 * Служебные пути, которые не должны отвечать 200 посторонним.
 *
 * Список намеренно короткий и состоит из ФАЙЛОВ, утечка которых сама по себе
 * есть происшествие: ключи, история репозитория, дампы. Мы их не читаем и не
 * используем — только фиксируем, что они открыты.
 */
export const SENSITIVE_PATHS = [
  '/.env',
  '/.git/config',
  '/wp-config.php.bak',
  '/backup.zip',
  '/phpinfo.php',
  '/.DS_Store',
] as const;

const HEADER_CHECKS: Array<{ id: string; header: string; severity: Severity; human: string }> = [
  { id: 'hsts', header: 'strict-transport-security', severity: 'medium', human: 'HSTS' },
  { id: 'csp', header: 'content-security-policy', severity: 'medium', human: 'Content-Security-Policy' },
  { id: 'nosniff', header: 'x-content-type-options', severity: 'low', human: 'X-Content-Type-Options' },
  { id: 'frame', header: 'x-frame-options', severity: 'low', human: 'защита от кликджекинга' },
];

/** Заголовки, выдающие версию ПО: по ним подбирают готовый эксплойт. */
const VERSION_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'];

/** Сертификату меньше этого — предупреждаем: продление обычно забывают. */
export const CERT_WARN_DAYS = 14;

/**
 * Разбор снимка в проверки. Чистая функция — вся сеть снаружи, чтобы правила
 * можно было судить тестами, а не прогоном по живому чужому сайту.
 */
export function auditSnapshot(snap: SiteSnapshot): CheckResult[] {
  const out: CheckResult[] = [];
  const unreachable = snap.status === null;

  const unknownIf = (id: string, severity: Severity, why: string): CheckResult => ({
    id, outcome: 'unknown', severity, detail: why,
  });

  // ── Доступность ──────────────────────────────────────────────────────────
  if (unreachable) {
    out.push({
      id: 'reachable', outcome: 'bad', severity: 'high',
      detail: `сайт не ответил: ${snap.failure ?? 'причина не зафиксирована'}`,
    });
    // Всё остальное проверить было НЕЧЕМ. Молчание тут читалось бы как
    // «нарушений не найдено» — а мы просто не смотрели.
    out.push(unknownIf('https', 'high', 'сайт не ответил — проверить не смогли'));
    out.push(unknownIf('cert', 'high', 'сайт не ответил — проверить не смогли'));
    for (const h of HEADER_CHECKS) out.push(unknownIf(h.id, h.severity, 'сайт не ответил — проверить не смогли'));
    out.push(unknownIf('version-disclosure', 'low', 'сайт не ответил — проверить не смогли'));
    out.push(unknownIf('mixed-content', 'medium', 'сайт не ответил — проверить не смогли'));
    out.push(unknownIf('exposed-paths', 'high', 'сайт не ответил — проверить не смогли'));
    return out;
  }

  // ── HTTPS ────────────────────────────────────────────────────────────────
  const isHttps = (snap.finalUrl ?? '').startsWith('https://');
  if (!isHttps) {
    out.push({
      id: 'https', outcome: 'bad', severity: 'high',
      detail: 'сайт работает без HTTPS: данные посетителя идут открытым текстом',
    });
  } else if (snap.httpRedirectsToHttps === false) {
    out.push({
      id: 'https', outcome: 'bad', severity: 'medium',
      detail: 'HTTPS есть, но http:// не перенаправляет на него',
    });
  } else if (snap.httpRedirectsToHttps === null) {
    out.push(unknownIf('https', 'medium', 'HTTPS есть; перенаправление с http:// проверить не смогли'));
  } else {
    out.push({ id: 'https', outcome: 'ok', severity: 'high', detail: 'HTTPS с перенаправлением' });
  }

  // ── Сертификат ───────────────────────────────────────────────────────────
  //
  // Доверие спрашивается ПЕРВЫМ и отдельно от срока. До 23.08.2026 здесь
  // смотрели только на дату, и сертификат, который браузер отвергает —
  // самоподписанный или выписанный на другое имя, — проходил как `ok`, если
  // дата была дальняя (js/disabling-certificate-validation).
  if (snap.certTrusted === false) {
    out.push({
      id: 'cert', outcome: 'bad', severity: 'high',
      detail: `сертификат не проходит проверку: ${snap.certUntrustedReason ?? 'причина не названа'}`
        + ' — браузер покажет предупреждение независимо от срока',
    });
  } else if (snap.certDaysLeft === null) {
    out.push(unknownIf('cert', 'high', 'срок сертификата снять не удалось'));
  } else if (snap.certTrusted === null) {
    out.push(unknownIf('cert', 'high', `срок есть (${snap.certDaysLeft} сут), но проверку доверия провести не удалось`));
  } else if (snap.certDaysLeft < 0) {
    out.push({
      id: 'cert', outcome: 'bad', severity: 'high',
      detail: `сертификат истёк ${Math.abs(snap.certDaysLeft)} сут назад — браузер покажет предупреждение`,
    });
  } else if (snap.certDaysLeft < CERT_WARN_DAYS) {
    out.push({
      id: 'cert', outcome: 'bad', severity: 'medium',
      detail: `сертификату осталось ${snap.certDaysLeft} сут`,
    });
  } else {
    out.push({ id: 'cert', outcome: 'ok', severity: 'high', detail: `сертификат действует ещё ${snap.certDaysLeft} сут` });
  }

  // ── Заголовки ────────────────────────────────────────────────────────────
  for (const h of HEADER_CHECKS) {
    const value = snap.headers[h.header];
    out.push(value
      ? { id: h.id, outcome: 'ok', severity: h.severity, detail: `${h.human} задан` }
      : { id: h.id, outcome: 'bad', severity: h.severity, detail: `${h.human} не задан` });
  }

  // ── Раскрытие версий ─────────────────────────────────────────────────────
  const disclosed = VERSION_HEADERS
    .map((h) => (snap.headers[h] ? `${h}: ${snap.headers[h]}` : null))
    .filter((x): x is string => x !== null)
    // Версия — это цифры. «nginx» без версии эксплойт не подбирает.
    .filter((s) => /\d/.test(s));
  out.push(disclosed.length > 0
    ? { id: 'version-disclosure', outcome: 'bad', severity: 'low', detail: `версия ПО в заголовках: ${disclosed.join('; ').slice(0, 200)}` }
    : { id: 'version-disclosure', outcome: 'ok', severity: 'low', detail: 'версия ПО в заголовках не раскрыта' });

  // ── Смешанный контент ────────────────────────────────────────────────────
  if (snap.html === null) {
    out.push(unknownIf('mixed-content', 'medium', 'разметку получить не удалось'));
  } else if (!isHttps) {
    out.push(unknownIf('mixed-content', 'medium', 'сайт без HTTPS — смешивать нечего'));
  } else {
    const mixed = /(?:src|href)\s*=\s*["']http:\/\//i.test(snap.html);
    out.push(mixed
      ? { id: 'mixed-content', outcome: 'bad', severity: 'medium', detail: 'на HTTPS-странице есть ресурсы по http://' }
      : { id: 'mixed-content', outcome: 'ok', severity: 'medium', detail: 'смешанного контента не видно' });
  }

  // ── Открытые служебные пути ──────────────────────────────────────────────
  if (!snap.pathsProbed) {
    out.push(unknownIf('exposed-paths', 'high', 'служебные пути не проверялись'));
  } else if (snap.exposedPaths.length > 0) {
    out.push({
      id: 'exposed-paths', outcome: 'bad', severity: 'high',
      detail: `открыты посторонним: ${snap.exposedPaths.join(', ')}`,
    });
  } else {
    out.push({ id: 'exposed-paths', outcome: 'ok', severity: 'high', detail: 'служебные файлы закрыты' });
  }

  return out;
}

export interface AuditVerdict {
  verdict: 'ok' | 'issues' | 'unknown';
  badCount: number;
  unknownCount: number;
}

/**
 * Итог по разбору.
 *
 * «Не смогли проверить» НЕ засчитывается за «хорошо»: если ни одна проверка не
 * дала определённого ответа, итог — `unknown`, и это состояние отличимо от
 * благополучия. Обратное давало бы зелёный отчёт по сайту, которого мы даже
 * не видели.
 */
export function summarize(checks: CheckResult[]): AuditVerdict {
  const badCount = checks.filter((c) => c.outcome === 'bad').length;
  const unknownCount = checks.filter((c) => c.outcome === 'unknown').length;
  const known = checks.filter((c) => c.outcome !== 'unknown').length;
  if (known === 0) return { verdict: 'unknown', badCount, unknownCount };
  return { verdict: badCount > 0 ? 'issues' : 'ok', badCount, unknownCount };
}

/**
 * Частный ли это адрес: петля, внутренняя сеть, link-local, метаданные облака.
 *
 * Отдельной функцией и с IPv6, потому что первая редакция знала только
 * IPv4-точки — а `[::1]`, `[fd00::1]` и `[fe80::1]` пролезали свободно.
 */
export function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 — link-local; там же 169.254.169.254, метаданные облака:
    // адрес, ради которого SSRF обычно и затевают.
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                          // multicast и выше
    return false;
  }

  // IPv6
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;  // fc00::/7 — уникальные локальные
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;  // fe80::/10 — link-local
  // IPv4, завёрнутый в IPv6: ::ffff:169.254.169.254
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateAddress(mapped[1]);

  return false;
}

/** Годится ли адрес для проверки: только http(s) и только внешние имена. */
/** Годится ли адрес для проверки: только http(s) и только внешние имена. */
export function isAuditableUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  // Свои и внутренние адреса не проверяем: смысла нет, а попасть по внутренней
  // сети из-за кривой записи в БД или чужого перенаправления — можно.
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isPrivateAddress(host)) return false;
  if (host === 'vedarai.ru' || host.endsWith('.vedarai.ru')) return false;
  // Голый IP не проверяем вовсе, даже публичный: у сайта оператора есть имя, а
  // цифры в поле website — почти наверняка ошибка или чья-то внутренняя машина.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return false;
  return host.includes('.');
}
