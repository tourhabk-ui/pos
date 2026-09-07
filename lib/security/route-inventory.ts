/**
 * Перепись API-роутов: чем закрыт каждый из семисот с лишним.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * Внешний аудит 07.09: «754 роута — уровень, где полагаться на middleware
 * уже нельзя, и по имени файла не видно, проверяет ли он что-нибудь».
 * Возражение верное: держать это в голове невозможно, а «наверное там всё
 * хорошо» — не ответ.
 *
 * ── Чего перепись НЕ утверждает ───────────────────────────────────────────
 *
 * Она НЕ говорит «роут открыт». Edge (`middleware.ts`) возвращает 401 всякому
 * `/api`, которого нет в реестре `PUBLIC_API_ROUTES`, — то есть подлинность
 * там проверяется всегда. Перепись отвечает на другой вопрос: видно ли, что
 * роут проверяет ПРАВА и ВЛАДЕНИЕ, а не только факт входа. Разница ровно та,
 * из-за которой турист, войдя под собой, читает чужую бронь.
 *
 * ── Почему сканировать один файл недостаточно ─────────────────────────────
 *
 * Первая редакция этой переписи смотрела только тело `route.ts` и дала
 * тридцать «неохраняемых» роутов. Разбор глазами показал, что как минимум
 * трое из них охраняются, просто на один импорт дальше:
 *   - `/api/bookings/[id]` зовёт `verifyAuth` и сверяет владение через
 *     `getBookingForUser(id, auth.userId)` — сигнала не было в списке;
 *   - `/api/admin/auth/issue-token` сверяет ключ через `timingSafeEqual`;
 *   - `/api/webhooks/cloudpayments` проверяет HMAC внутри
 *     `processCloudPaymentsWebhook`, то есть в соседнем модуле.
 *
 * Поэтому проверка идёт на ОДИН ПЕРЕХОД вглубь: роут плюс те `@/lib/*`,
 * которые он импортирует. Дальше не идём сознательно — двухходовка начнёт
 * находить защиту через общие утилиты и красить всё зелёным, а это хуже, чем
 * не проверять вовсе.
 *
 * ── Третий исход ──────────────────────────────────────────────────────────
 *
 * `needs_review` — это «не нашли», а не «не защищено». Разница обязана быть
 * видимой: список замораживается тестом и может только сокращаться. Роут,
 * добавленный без видимой проверки и без записи в реестр публичных, красит
 * сборку — молчание тут не ответ (§4.0).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Что нашлось у роута. */
export type RouteProtection =
  /** Видна проверка входа/роли/владения — в самом роуте или на импорт глубже. */
  | 'guarded'
  /** Видна проверка подписи вызывающего (вебхук платёжного шлюза, бота). */
  | 'signature'
  /** Объявлен публичным в реестре Edge — открыт намеренно. */
  | 'declared_public'
  /** Ничего из перечисленного не нашли. НЕ равно «открыт»: см. шапку. */
  | 'needs_review';

export interface RouteRecord {
  /** Путь запроса: /api/... */
  url: string;
  /** Файл относительно корня репозитория. */
  file: string;
  protection: RouteProtection;
}

/**
 * Имена, означающие проверку вызывающего. Собраны ИЗ ФАКТИЧЕСКИХ импортов
 * роутов (`grep` по `from '@/lib/auth'`), а не из памяти: первая редакция
 * писалась по памяти и пропустила `verifyAuth`, который стоит в двадцати двух
 * роутах, включая бронь по идентификатору.
 */
const AUTH_SIGNALS = [
  'requireAdmin', 'requireAuth', 'requireOperator', 'requireRole', 'requireAgent',
  'requireAccommodationAccess', 'verifyAuth', 'getUserFromRequest', 'verifyToken',
  'getCronSecret', 'verifyCronSecret', 'diagnoseCronAuth',
  'getOperatorPartnerId', 'getGuidePartnerId', 'getStayPartnerId',
  'verifyTourOwnership', 'getTouristProfile', 'ensurePartnerForRole',
] as const;

/** Проверка подписи вызывающего: платёжные шлюзы, боты. */
const SIGNATURE_SIGNALS = [
  'createHmac', 'validateCloudPaymentsSignature', 'processCloudPaymentsWebhook',
  'verifySignature', 'checkSignature', 'verifyWebhook',
  'timingSafeEqual', 'timingSafeCompare',
] as const;

function hasAny(src: string, names: readonly string[]): boolean {
  return names.some((n) => new RegExp(`\\b${n}\\b`).test(src));
}

/** Локальные модули, которые импортирует файл: '@/lib/x' → lib/x. */
function localImports(src: string): string[] {
  return [...src.matchAll(/from\s+'@\/((?:lib|app)\/[^']+)'/g)].map((m) => m[1]);
}

function readIfExists(root: string, base: string): string {
  for (const ext of ['.ts', '.tsx', '/index.ts']) {
    try {
      return readFileSync(join(root, base + ext), 'utf-8');
    } catch { /* следующий вариант */ }
  }
  return '';
}

function walkRoutes(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkRoutes(p, out);
    else if (e === 'route.ts') out.push(p);
  }
  return out;
}

/** Пути, объявленные публичными в реестре Edge. */
export function declaredPublicPaths(root: string): string[] {
  const src = readFileSync(join(root, 'lib/auth/public-api-routes.ts'), 'utf-8');
  const body = src.slice(src.indexOf('PUBLIC_API_ROUTES'));
  return [...body.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
}

/**
 * Перепись целиком. Чистая функция от файлов: ничего не сети, ничего не пишет.
 */
export function inventoryRoutes(root: string): RouteRecord[] {
  const declared = declaredPublicPaths(root);
  return walkRoutes(join(root, 'app/api')).sort().map((file) => {
    const src = readFileSync(file, 'utf-8');
    const rel = relative(root, file);
    const url = '/' + rel.replace(/^app\//, '').replace(/\/route\.ts$/, '');

    // Один переход вглубь: сам роут плюс его локальные модули.
    const reach = [src, ...localImports(src).map((m) => readIfExists(root, m))].join('\n');

    let protection: RouteProtection;
    if (hasAny(reach, AUTH_SIGNALS)) protection = 'guarded';
    else if (hasAny(reach, SIGNATURE_SIGNALS)) protection = 'signature';
    else if (declared.some((d) => url === d || url.startsWith(d.replace(/\*$/, '')))) {
      protection = 'declared_public';
    } else protection = 'needs_review';

    return { url, file: rel, protection };
  });
}

/** Сводка по родам — для отчёта и для сторожа. */
export function summarize(records: RouteRecord[]): Record<RouteProtection, number> {
  const acc: Record<RouteProtection, number> = {
    guarded: 0, signature: 0, declared_public: 0, needs_review: 0,
  };
  for (const r of records) acc[r.protection] += 1;
  return acc;
}
