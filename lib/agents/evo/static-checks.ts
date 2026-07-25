/**
 * Детерминированные объективы эволюции.
 *
 * Зачем: LLM-ревью просят «найди проблемы», и модель, не найдя, изобретает —
 * инцидент 24.07 дал 10 ложных critical про один booking-роут (семь
 * перефразировок «нет requireAuth» при живых verifyToken/extractToken).
 * Проверки ниже не гадают: они ищут КОНКРЕТНЫЙ синтаксис по реальным
 * паттернам проекта (CLAUDE.md §4), поэтому либо находят факт, либо молчат.
 *
 * Философия репо (§8): детерминированный инструмент вместо правил в промпте.
 * Мок-детектор уже доказал подход — за ночь ноль ложных находок.
 *
 * Чистые функции: (путь, содержимое) → находки. Ни сети, ни БД.
 */
import type { GrowthIssue } from '@/lib/agents/evo/growth-agent';

/**
 * Признаки реальной auth-защиты в этом проекте (НЕ выдуманные NextAuth/Prisma).
 *
 * Аудит админки 24.07 показал два ложных срабатывания: роуты защищены, но не
 * именованным хелпером — `issue-token` сверяет ADMIN_TOKEN_SECRET через
 * timingSafeEqual из crypto, `max-send` сравнивает Authorization с CRON_SECRET
 * инлайном. Гвард обязан знать и такие формы, иначе сам порождает ложь.
 */
const AUTH_MARKERS =
  /requireAuth|requireAdmin|requireRole|requireOperator|requireAgent|requireTransferOperator|requireStayOwner|verifyToken|extractToken|verifyCronSecret|getCronSecret|timingSafeCompare|timingSafeEqual|CRON_SECRET|ADMIN_TOKEN_SECRET|WEBHOOK_SECRET|createHmac/;

/** Мутирующие HTTP-методы: именно их незащищённость опасна. */
const MUTATING_EXPORT = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/g;

/**
 * Публичные по замыслу мутирующие роуты — здесь отсутствие auth не находка.
 * Список ручной и узкий: вебхуки с подписью, публичные формы, платёжные колбэки.
 */
const PUBLIC_MUTATING_ROUTES = [
  'app/api/webhook/',
  'app/api/payments/',
  'app/api/auth/',
  'app/api/kuzmich/',
  'app/api/ai/chat',
  'app/api/telegram/',
  'app/api/max/',
  'app/api/partners/register',
  'app/api/leads/',
  'app/api/sos/',
  'app/api/safety/sos',
  'app/api/reviews/',
  'app/api/subscribe',
  'app/api/contact',
];

function isPublicMutatingRoute(path: string): boolean {
  return PUBLIC_MUTATING_ROUTES.some((p) => path.startsWith(p));
}

/**
 * Мутирующий API-роут без единого маркера аутентификации.
 * Ровно та проверка, которую LLM пыталась делать «на глаз» и врала.
 */
export function checkRouteAuthGate(path: string, content: string): GrowthIssue[] {
  if (!/^app\/api\/.*\/route\.ts$/.test(path)) return [];
  if (isPublicMutatingRoute(path)) return [];

  const methods = [...content.matchAll(MUTATING_EXPORT)].map((m) => m[1]);
  if (methods.length === 0) return [];
  if (AUTH_MARKERS.test(content)) return [];

  return [{
    category: 'security',
    severity: 'critical',
    file_path: path,
    title: `Мутирующий роут без auth: ${methods.join('/')}`,
    description:
      `В ${path} экспортируется ${methods.join('/')}, но в файле нет ни одного маркера ` +
      `аутентификации проекта (requireAuth/requireRole/verifyToken/…). Проверено детерминированно: ` +
      `поиск по тексту файла, не оценка модели.`,
    suggestion:
      'Добавить гвард в начало обработчика (requireAuth / requireRole / профильный requireXxx). ' +
      'Если роут публичен по замыслу — внести путь в PUBLIC_MUTATING_ROUTES в lib/agents/evo/static-checks.ts.',
  }];
}

/** Устаревшие таблицы и импорты — прямые запреты CLAUDE.md §4. */
export function checkLegacyUsage(path: string, content: string): GrowthIssue[] {
  if (!(path.startsWith('lib/') || path.startsWith('app/'))) return [];
  if (path.includes('.test.') || path.includes('__tests__')) return [];

  const issues: GrowthIssue[] = [];
  const lineOf = (re: RegExp): number | undefined => {
    const idx = content.search(re);
    return idx < 0 ? undefined : content.slice(0, idx).split('\n').length;
  };

  const defaultPoolImport = /import\s+pool\s+from\s+['"]@\/lib\/db-pool['"]/;
  if (defaultPoolImport.test(content)) {
    issues.push({
      category: 'tech_debt', severity: 'medium', file_path: path, line_number: lineOf(defaultPoolImport),
      title: 'Дефолтный импорт pool вместо именованного',
      description: `${path}: import pool from '@/lib/db-pool' — CLAUDE.md §4 требует именованный импорт.`,
      suggestion: "Заменить на import { pool } from '@/lib/db-pool'.",
    });
  }

  const legacyBookings = /\bFROM\s+bookings\b/i;
  if (legacyBookings.test(content)) {
    issues.push({
      category: 'bug', severity: 'high', file_path: path, line_number: lineOf(legacyBookings),
      title: 'Запрос к устаревшей таблице bookings',
      description: `${path}: FROM bookings — актуальная таблица operator_bookings (колонка booking_status).`,
      suggestion: 'Перевести запрос на operator_bookings.',
    });
  }

  const legacyTours = /\bFROM\s+tours\b/i;
  if (legacyTours.test(content)) {
    issues.push({
      category: 'bug', severity: 'high', file_path: path, line_number: lineOf(legacyTours),
      title: 'Запрос к устаревшей таблице tours',
      description: `${path}: FROM tours — актуальная operator_tours (или v_kamchatka_routes_api для публичных маршрутов).`,
      suggestion: 'Перевести запрос на operator_tours / v_kamchatka_routes_api.',
    });
  }

  const legacyArk = /INSERT\s+INTO\s+agent_route_knowledge/i;
  if (legacyArk.test(content)) {
    issues.push({
      category: 'bug', severity: 'high', file_path: path, line_number: lineOf(legacyArk),
      title: 'INSERT в agent_route_knowledge (это VIEW)',
      description: `${path}: прямой INSERT в agent_route_knowledge — CLAUDE.md §4.1 запрещает, это VIEW.`,
      suggestion: 'Писать в мастер-таблицы places или kamchatka_routes.',
    });
  }

  return issues;
}

/** console.log в продакшн-коде — запрет CLAUDE.md §4 (console.error санкционирован). */
export function checkConsoleLog(path: string, content: string): GrowthIssue[] {
  if (!(path.startsWith('lib/') || path.startsWith('app/api/'))) return [];
  if (path.includes('.test.') || path.includes('__tests__')) return [];

  const lines = content.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/\bconsole\.log\s*\(/.test(code)) hits.push(i + 1);
  });
  if (hits.length === 0) return [];

  return [{
    category: 'tech_debt', severity: 'low', file_path: path, line_number: hits[0],
    title: `console.log в продакшн-коде (${hits.length})`,
    description: `${path}: console.log на строках ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? '…' : ''}. CLAUDE.md §4 запрещает.`,
    suggestion: 'Убрать или заменить на структурный логгер / console.error для ошибок.',
  }];
}

/** Все детерминированные объективы разом. */
export function runStaticChecks(path: string, content: string): GrowthIssue[] {
  return [
    ...checkRouteAuthGate(path, content),
    ...checkLegacyUsage(path, content),
    ...checkConsoleLog(path, content),
  ];
}
