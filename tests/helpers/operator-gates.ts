/**
 * Реестр гейтов кабинета оператора (CRM фаза 2г) и разбор кода для его
 * сторожей: tests/unit/operator-team-gates.test.ts (роуты) и
 * tests/unit/operator-team-menu.test.ts (меню и экраны). Объяснение исходов —
 * в шапке operator-team-gates.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Perm = 'can_edit_prices' | 'can_cancel_bookings';

export type Gate =
  | { seat: 'owner' }
  | { seat: 'team'; perms?: Perm[]; ownerOnly?: string; moneyHidden?: true; resolvedIn?: string }
  | { seat: 'user'; why: string }
  | { seat: 'public'; why: string };

export const GATES: Record<string, Gate> = {
  // ── Деньги и настройки: только владелец кабинета ──
  'app/api/hub/operator/earnings/route.ts': { seat: 'owner' },
  'app/api/hub/operator/payouts/route.ts': { seat: 'owner' },
  'app/api/hub/operator/reports/route.ts': { seat: 'owner' },
  'app/api/hub/operator/settings/auto-confirm/route.ts': { seat: 'owner' },
  'app/api/hub/operator/bookings/[id]/direct-payments/route.ts': { seat: 'owner' },
  'app/api/hub/operator/team/route.ts': { seat: 'owner' },
  'app/api/hub/operator/team/[id]/route.ts': { seat: 'owner' },
  'app/api/operator/guides/invites/route.ts': { seat: 'owner' },
  'app/api/operator/analytics/route.ts': { seat: 'owner' },
  'app/api/hub/crm/keys/route.ts': { seat: 'owner' },
  'app/api/hub/crm/keys/[id]/route.ts': { seat: 'owner' },
  'app/api/hub/crm/channel/route.ts': { seat: 'owner' },
  'app/api/hub/crm/channel/link/route.ts': { seat: 'owner' },
  'app/api/mcp/partner/oauth/authorize/route.ts': { seat: 'owner' },

  // ── Команда: владелец и менеджер ──
  'app/api/hub/operator/me/route.ts': { seat: 'team' },
  'app/api/hub/operator/profile/route.ts': { seat: 'team', ownerOnly: 'правка профиля компании', moneyHidden: true },
  'app/api/operator/dashboard/route.ts': { seat: 'team', moneyHidden: true },
  'app/api/operator/stats/route.ts': { seat: 'team', moneyHidden: true },
  'app/api/hub/operator/notifications/route.ts': { seat: 'team' },
  'app/api/hub/operator/leads/report/route.ts': { seat: 'team' },
  'app/api/hub/selections/route.ts': { seat: 'team' },
  // AI-помощник: роут отдаёт команду агентству, кабинет и права ищет оно.
  'app/api/agents/operator/route.ts': {
    seat: 'team', resolvedIn: 'lib/agents/agencies/operator-agency.ts',
    perms: ['can_edit_prices'], ownerOnly: 'выручка за 7 и 30 дней',
  },
  'app/api/hub/operator/weather/route.ts': { seat: 'team' },
  'app/api/hub/operator/bookings/route.ts': { seat: 'team', perms: ['can_edit_prices'], ownerOnly: '«оплачено» в ручной брони' },
  'app/api/hub/operator/bookings/[id]/route.ts': { seat: 'team', perms: ['can_cancel_bookings'] },
  'app/api/hub/operator/bookings/[id]/guide/route.ts': { seat: 'team' },
  'app/api/hub/operator/pricing-rules/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  'app/api/hub/operator/tours/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  'app/api/hub/operator/tours/[id]/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  'app/api/hub/operator/tours/[id]/availability/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  // Календарь (2г-2б): даты и места — команде, цена на дату — по праву цен,
  // выручка месяца — владельцу.
  'app/api/operator/calendar/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  'app/api/operator/calendar/block/route.ts': { seat: 'team' },
  'app/api/operator/calendar/bulk-open/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  'app/api/operator/calendar/ical/route.ts': { seat: 'team' },
  'app/api/hub/operator/bookings-calendar/route.ts': { seat: 'team', moneyHidden: true },
  'app/api/hub/operator/tours/import/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  'app/api/operator/bookings/route.ts': { seat: 'team' },
  'app/api/operator/bookings/[id]/route.ts': { seat: 'team', perms: ['can_cancel_bookings'], ownerOnly: 'статус оплаты брони' },
  'app/api/operator/completeness/route.ts': { seat: 'team' },
  'app/api/operator/guides/route.ts': { seat: 'team', ownerOnly: 'исключить гида из команды' },
  'app/api/operator/mchs-registrations/route.ts': { seat: 'team' },
  'app/api/operator/mchs/[id]/route.ts': { seat: 'team' },
  'app/api/operator/mchs/register/route.ts': { seat: 'team' },
  'app/api/operator/reviews/route.ts': { seat: 'team' },
  'app/api/operator/reviews/[id]/reply/route.ts': { seat: 'team' },
  'app/api/operator/tours/[id]/deactivate/route.ts': { seat: 'team' },
  'app/api/operator/tours/[id]/generate-tags/route.ts': { seat: 'team' },
  'app/api/operator/tours/[id]/publish/route.ts': { seat: 'team' },
  'app/api/operator/tours/quick-fill/route.ts': { seat: 'team', perms: ['can_edit_prices'] },
  'app/api/operator/tours/auto-fill-ai/route.ts': { seat: 'team' },
  'app/api/hub/crm/contacts/route.ts': { seat: 'team' },
  'app/api/hub/crm/contacts/[id]/route.ts': { seat: 'team' },
  'app/api/hub/crm/contacts/[id]/events/route.ts': { seat: 'team' },
  'app/api/hub/crm/contacts/export/route.ts': { seat: 'team' },
  'app/api/hub/crm/inbox/route.ts': { seat: 'team' },
  'app/api/hub/crm/seat-requests/[id]/answer/route.ts': { seat: 'team' },
  'app/api/hub/crm/tasks/route.ts': { seat: 'team' },
  'app/api/hub/crm/tasks/[id]/route.ts': { seat: 'team' },

  // ── Данные самого аккаунта: кабинет не ищется ──
  'app/api/hub/operator/upload/route.ts': {
    seat: 'user', why: 'фото тура в хранилище под ключом аккаунта; в тур его кладёт роут тура со своим гейтом',
  },
  'app/api/upload/tour-photo/route.ts': {
    seat: 'user', why: 'то же для формы тура: только загрузка, тур не меняется',
  },
  'app/api/hub/operator/tours/import-pdf/route.ts': {
    seat: 'user', why: 'разбор PDF в поля формы, ничего не пишет; тур создаёт роут с правом can_edit_prices',
  },
  'app/api/ai/booking-intake/route.ts': {
    seat: 'user', why: 'разбор текста заявки в поля, ничего не пишет; бронь создаёт роут ручной брони',
  },
  'app/api/operator/templates/route.ts': {
    seat: 'user', why: 'шаблоны сообщений привязаны к аккаунту (message_templates по users.id): у менеджера свои; общие кабинету — шаг 2г-3',
  },

  // ── Без входа ──
  'app/api/hub/operator/payments/webhook/route.ts': {
    seat: 'public', why: 'приёмник оплаты CloudPayments (§7, не трогать): подпись проверяет сам роут',
  },
};

/** Каталоги кабинета: каждый route.ts в них обязан быть в GATES. */
export const CABINET_DIRS = ['app/api/hub/operator', 'app/api/operator', 'app/api/hub/crm'];

/** Адреса, которые кабинет зовёт, но держит другой сторож. */
export const HELD_ELSEWHERE: Record<string, string> = {
  'app/api/leads/': 'лиды кабинета — leadOwnershipCond / canAccessLead, сторож leads-idor',
  'app/api/auth/': 'свой аккаунт: профиль и пароль',
  'app/api/kamchatka-routes/': 'публичный каталог маршрутов',
  'app/api/telegram/connect/': 'свой Telegram аккаунта (users.telegram_id)',
};

export const ROOT = process.cwd();
export const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Код без комментариев: упоминание резолвера в пояснении — не вызов. */
export function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

export const OWNER_GATE = /\brequireOperatorOwner\(|\brequirePartnerOwner\(/;
export const TEAM_RESOLVER = /\brequireOperatorTeam\(|\bgetOperatorPartnerId\(|\boperatorAccess\(|\boperatorOwnsBooking\(|\bleadOwnershipCond\(|\bpartnerContextFor\(|\brequirePartner\(/;
export const INLINE_OWNER_LOOKUP = /FROM\s+partners\s+(?:p\s+)?WHERE\s+(?:p\.)?user_id\s*=\s*\$\d|\bp\.user_id\s*=\s*\$\d|\bverify(?:Booking|Tour)Ownership\(/;
// this.cabinet(…, 'owner') — вызов, а не сигнатура: в объявлении `need?: 'owner' | …`
// слово тоже есть, и признак по нему засчитывал бы снятый гейт.
export const OWNER_ACTION = /\bownerOnlyDenied\(\)|\brequireOperatorOwner\(|\brequirePartnerOwner\(|\bthis\.cabinet\([^)]*'owner'/;
export const MONEY_HIDDEN = /\bdashboardWithoutMoney\(|access\.kind\s*===\s*'owner'/;
export const AUTH_CALL = /\brequire(?:Operator|Auth|Role|Admin|Partner|OperatorTeam|OperatorOwner|PartnerOwner)\(/;
export const PERMS: Perm[] = ['can_edit_prices', 'can_cancel_bookings'];
export const permGate = (perm: Perm) => new RegExp(`(?:\\b(?:requireTeamPermission|managerMay|permissionDenied)|\\bthis\\.cabinet)\\([^)]*'${perm}'`);

/** Деньги и настройки по адресу: такие роуты не бывают командными. */
export const MONEY_RE = /\/(?:earnings|payouts?|reports|payments?|direct-payments|commissions?|finance|settings|keys|channel|oauth|team|invites|analytics)(?:\/|$)/;

export const HANDLER_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g;
export const DEF_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\b|\()/gm;

export function handlers(src: string): { name: string; body: string }[] {
  const marks = [...src.matchAll(HANDLER_RE)].map(m => ({ name: m[1] ?? m[2], at: m.index ?? 0 }));
  return marks.map((m, i) => ({ name: m.name, body: src.slice(m.at, marks[i + 1]?.at ?? src.length) }));
}

/** Тела функций верхнего уровня: обработчик может звать гейт через свою обёртку. */
export function helpers(src: string): Map<string, string> {
  const defs = [...src.matchAll(DEF_RE)].map(m => ({ name: m[1] ?? m[2], at: m.index ?? 0 }));
  const out = new Map<string, string>();
  defs.forEach((d, i) => out.set(d.name, src.slice(d.at, defs[i + 1]?.at ?? src.length)));
  return out;
}

/**
 * Псевдонимы: `const getOperatorId = getOperatorPartnerId;` — вызов
 * псевдонима и есть вызов резолвера.
 */
export function withAliases(re: RegExp, src: string): RegExp {
  const names = [...src.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*;/g)]
    .filter(m => re.test(`${m[2]}(`))
    .map(m => m[1]);
  return names.length ? new RegExp(`${re.source}|\\b(?:${names.join('|')})\\(`) : re;
}

/** Обработчик проходит через re — сам или через функцию этого же файла. */
export function handlerReaches(body: string, re: RegExp, fns: Map<string, string>): boolean {
  if (re.test(body)) return true;
  for (const [name, fnBody] of fns) {
    if (re.test(fnBody) && new RegExp(`\\b${name}\\(`).test(body)) return true;
  }
  return false;
}

export function routeFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...routeFiles(rel));
    else if (name === 'route.ts') out.push(rel);
  }
  return out;
}

export function permsInCode(c: string): Perm[] {
  return PERMS.filter(p => permGate(p).test(c));
}

/** URL кабинета → файл роута: статический сегмент или [параметр]. */
export function resolveRoute(url: string): string | null {
  const segs = url.replace(/^\/api\//, '').split('/').filter(Boolean);
  const walk = (dir: string, i: number): string | null => {
    if (i === segs.length) return existsSync(join(ROOT, dir, 'route.ts')) ? `${dir}/route.ts` : null;
    const seg = segs[i];
    if (seg !== ':p' && existsSync(join(ROOT, dir, seg))) {
      const hit = walk(`${dir}/${seg}`, i + 1);
      if (hit) return hit;
    }
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return null;
    for (const name of readdirSync(abs)) {
      if (/^\[.+\]$/.test(name) && statSync(join(abs, name)).isDirectory()) {
        const hit = walk(`${dir}/${name}`, i + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk('app/api', 0);
}

export function sourceFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(rel);
  }
  return out;
}


/** Адреса /api/, которые зовут файлы: шаблонная часть адреса — «:p». */
export function apiUrlsIn(files: string[]): Set<string> {
  const urls = new Set<string>();
  for (const f of files) {
    for (const m of read(f).matchAll(/[`'"](\/api\/[^`'"?\s#]+)/g)) {
      urls.add(m[1].replace(/\$\{[^}]*\}/g, ':p').replace(/\/+$/, ''));
    }
  }
  return urls;
}
