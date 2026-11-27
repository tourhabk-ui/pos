/**
 * lib/agents/tools/board-executor-tools.ts
 *
 * Реальные инструменты, которые Совет директоров может ИСПОЛНИТЬ.
 * Агенты больше не просто "разговаривают" — они действуют.
 *
 * Инструменты:
 *  - sendBoardAlert       — Telegram-уведомление администратору о действии агента
 *  - scanSQLErrors        — сканирует agency-файлы и возвращает список ошибок
 *
 * runDiagnosticQuery и applySchemaFix УДАЛЕНЫ 27.11 (задача владельца,
 * разбор находок #1428). Оба исполняли переданную строку SQL:
 *
 *  - applySchemaFix выполнял её целиком в транзакции. Чёрный список
 *    (DROP TABLE, TRUNCATE, DELETE FROM, UPDATE) обходился — регистром,
 *    другими словами DDL, функциями с побочным действием. Схема меняется
 *    только миграциями (CLAUDE.md), и этот путь её обходил;
 *  - runDiagnosticQuery оборачивал строку подзапросом и запрещал «;», но
 *    шёл без READ ONLY, без statement_timeout и под общей ролью: побочные
 *    функции, чтение персональных данных, долгий запрос на общем пуле.
 *
 * Ни одно агентство их не звало: рантайм-вызовов не было, а экспорт давал
 * дверь в обход реестра прав — прямой импорт функции реестр не спрашивает.
 * Сторож: tests/unit/no-raw-sql-exec.test.ts — в lib/ нет экспортированной
 * функции, которая отдаёт базе переданную строку без параметров.
 */

import fs from 'fs';
import path from 'path';
import { pool } from '@/lib/db-pool';

// ── Типы ─────────────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

// ── Маппинг неправильных → правильных колонок operator_bookings ─────────────

export const COLUMN_PATCH_MAP: Record<string, string> = {
  // operator_bookings: tour_id → operator_tour_id
  'ob.tour_id':              'ob.operator_tour_id',
  'b.tour_id':               'b.operator_tour_id',
  // operator_bookings: финансовые колонки
  'ob.total_amount':         'ob.final_price',
  'ob.total_price':          'ob.final_price',
  'b.total_price':           'b.final_price',
  'b.total_amount':          'b.final_price',
  'SUM(total_price)':        'SUM(final_price)',
  'AVG(total_amount)':       'AVG(final_price)',
  'total_amount > 0':        'final_price > 0',
  'total_amount IS NOT NULL': 'final_price IS NOT NULL',
  'total_amount IS NULL':    'final_price IS NULL',
  // operator_bookings: статус
  "ob.status IN ('new'":     "ob.booking_status IN ('new'",
  "ob.status IN ('confirmed'": "ob.booking_status IN ('confirmed'",
  "ob.status = 'cancelled'": "ob.booking_status = 'cancelled'",
  "ob.status = 'confirmed'": "ob.booking_status = 'confirmed'",
  "ob.status = 'completed'": "ob.booking_status = 'completed'",
  "b.status NOT IN":         "b.booking_status NOT IN",
  "b.status = 'cancelled'":  "b.booking_status = 'cancelled'",
  "b.status = 'confirmed'":  "b.booking_status = 'confirmed'",
  "status = 'confirmed'":    "booking_status = 'confirmed'",
  "status = 'cancelled'":    "booking_status = 'cancelled'",
  "status = 'completed'":    "booking_status = 'completed'",
  "status IN ('confirmed','completed')": "booking_status IN ('confirmed','completed')",
  "status IN ('new','confirmed')": "booking_status IN ('new','confirmed')",
  "status NOT IN ('cancelled')": "booking_status NOT IN ('cancelled')",
  "WHERE status NOT IN":     "WHERE booking_status NOT IN",
  "AND status NOT IN":       "AND booking_status NOT IN",
  // operator_bookings: прочие колонки
  'ob.participants_count':   'ob.participants',
  'b.guest_name':            'b.tourist_name',
  'b.guests_count':          'b.participants',
  // weather_alerts
  'wa.tour_id':              'wa.operator_tour_id',
  "wa.message":              "COALESCE(wa.alert_type, 'alert') || ' / ' || COALESCE(wa.severity, 'low')",
  'wa.location':             'wa.location_name',
  // tour_availability (standalone, context-free)
  "a.tour_id = t.id":        "a.operator_tour_id = t.id",
  "ta.tour_id = ot.id":      "ta.operator_tour_id = ot.id",
};

// Agency-файлы с известными ошибками
/**
 * Файлы, которые перепись читает.
 *
 * Было одиннадцать, из них девять удалены вместе с советом директоров ещё в
 * апреле. Перепись молча пропускала несуществующие (`existsSync` → continue),
 * поэтому список выглядел живым, а смотрел в пустоту.
 */
const AGENCY_FILES = [
  'rescue-agency.ts',
  'operator-agency.ts',
  'guide-agency.ts',
  'danger-analyst-agency.ts',
  'lead-agency.ts',
  'marketing-agency.ts',
  'tourist-agency.ts',
] as const;

const AGENCIES_DIR = path.join(process.cwd(), 'lib', 'agents', 'agencies');

/**
 * fixSQLColumnErrors УДАЛЁН 08.09 по находке аудита.
 *
 * Он переписывал ИСХОДНИКИ на проде подстрочной заменой и сохранял результат
 * на диск. Три довода, каждого хватило бы:
 *
 * 1. Это прямо запрещено ядром — `lib/agents/kernel/policy.ts`:
 *    «правка кода на проде мимо PR запрещена: код меняется только draft PR +
 *    merge человека». Запрет стоял на пути ядра, а `executeBoardTool` его не
 *    спрашивал: дверь заперли, окно оставили.
 *
 * 2. Замена шла БЕЗ ГРАНИЦ СЛОВА. В карте есть «WHERE status NOT IN» →
 *    «WHERE booking_status NOT IN», а в rescue-agency этой формой отбираются
 *    АКТИВНЫЕ SOS из `sos_events`, где колонки `booking_status` нет вовсе.
 *    Инструмент сломал бы сводку SOS целиком — тот самый запрос, который
 *    накануне чинили, чтобы живой сигнал перестал теряться. Там же
 *    «status = 'confirmed'» превратило бы уже правильное
 *    `b.booking_status` в `b.booking_booking_status`.
 *
 * 3. Девять из одиннадцати файлов, которые он «чинил», удалены вместе с
 *    советом директоров ещё в апреле. Из выживших двух один — rescue-agency.
 *
 * И сверх того: в standalone-образе Timeweb исходников `.ts` нет, так что
 * работать это не могло и по построению.
 *
 * `scanSQLErrors` оставлен как ПЕРЕПИСЬ — он только читает и ничего не пишет.
 */

// Per-key cooldown to suppress repeated alerts (e.g. Infra probing AI every hour)
const _alertCooldowns = new Map<string, number>();
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Отправляет Telegram-уведомление администратору о действии агента.
 * Повторные алерты с тем же agentName+action подавляются на 6 часов.
 */
export async function sendBoardAlert(
  agentName: string,
  action: string,
  details: string
): Promise<ToolResult> {
  const cooldownKey = `${agentName}:${action}`;
  const lastSent = _alertCooldowns.get(cooldownKey) ?? 0;
  if (Date.now() - lastSent < ALERT_COOLDOWN_MS) {
    return { success: true, message: 'Дублирующий алерт подавлен (кулдаун 6ч)' };
  }
  _alertCooldowns.set(cooldownKey, Date.now());

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_FISHING_CHAT_ID;

  if (!token || !chatId) {
    return {
      success: false,
      message: 'Telegram не настроен (нет TELEGRAM_BOT_TOKEN или TELEGRAM_FISHING_CHAT_ID)',
    };
  }

  const text = [
    '<b>Команда AI — действие агента</b>',
    '',
    `Агент: ${agentName}`,
    `Действие: ${action}`,
    `Детали: ${details}`,
    '',
    `Время: ${new Date().toLocaleString('ru-RU')}`,
  ].join('\n');

  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const json = await res.json() as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(json.description ?? 'Telegram error');
    return { success: true, message: 'Уведомление отправлено' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Ошибка Telegram: ${msg}` };
  }
}

/**
 * Сканирует agency-файлы и возвращает список найденных SQL-ошибок.
 */
export function scanSQLErrors(): { file: string; issues: string[] }[] {
  const report: { file: string; issues: string[] }[] = [];

  for (const fileName of AGENCY_FILES) {
    const filePath = path.join(AGENCIES_DIR, fileName);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const issues: string[] = [];

    for (const wrong of Object.keys(COLUMN_PATCH_MAP)) {
      if (content.includes(wrong)) {
        issues.push(wrong);
      }
    }

    if (issues.length > 0) {
      report.push({ file: fileName, issues });
    }
  }

  return report;
}

// ── Scope прав инструментов по агентствам (issue #327) ──────────────────────
//
// 73% AI-агентов имеют избыточные права. Явный whitelist «агентство → какими
// инструментами можно пользоваться» блокирует нежелательные действия (напр.
// rescue-agency не пишет схему БД и не патчит чужие файлы). Принцип наименьших
// привилегий: перепись + алерт. Инструментов записи в базу и в исходники
// больше нет вовсе (fixSQLColumnErrors — 08.09, applySchemaFix и
// runDiagnosticQuery — 27.11).

export const BOARD_TOOLS = [
  'sendBoardAlert',
  'scanSQLErrors',
] as const;

export type BoardToolName = (typeof BOARD_TOOLS)[number];

// Только перепись + право сообщить администратору.
const READONLY_SCOPE: BoardToolName[] = ['scanSQLErrors', 'sendBoardAlert'];

export const AGENCY_TOOL_SCOPE: Record<string, BoardToolName[]> = {
  // Только существующие агентства (находка аудита 08.09).
  //
  // Здесь стояли шесть удалённых вместе с советом директоров ещё в апреле —
  // admin, evolution, security, hacker, content-auditor, transfer, — и первым
  // двум был выписан ПОЛНЫЙ доступ, включая applySchemaFix (удалён 27.11), то есть правку
  // схемы прода мимо миграций. Права мёртвых не безобидны: имя агентства
  // приходит строкой, и любой, кто её подставит, получает то, чего никто
  // живой не имеет.
  //
  // Сторож `tests/unit/no-source-rewrite-on-prod.test.ts` держит правило:
  // каждое агентство реестра существует на диске.
  'rescue-agency': READONLY_SCOPE,
  'guide-agency': READONLY_SCOPE,
  'danger-analyst-agency': READONLY_SCOPE,
  'operator-agency': READONLY_SCOPE,
  'lead-agency': READONLY_SCOPE,
  'marketing-agency': READONLY_SCOPE,
  'tourist-agency': READONLY_SCOPE,
};

/** true, если агентству разрешён инструмент. Неизвестное агентство → запрет. */
export function isToolInScope(agency: string, tool: string): boolean {
  const scope = AGENCY_TOOL_SCOPE[agency];
  if (!scope) return false;
  return (scope as readonly string[]).includes(tool);
}

/**
 * Единая точка исполнения board-инструмента с проверкой scope. Инструмент вне
 * scope агентства отклоняется с SCOPE_DENIED и логируется — побочный эффект не
 * выполняется (guard стоит до вызова инструмента).
 */
export async function executeBoardTool(
  agency: string,
  tool: BoardToolName,
  args: unknown[] = [],
): Promise<ToolResult> {
  if (!isToolInScope(agency, tool)) {
    // Лог не блокирует ответ (и не роняет отказ, если БД недоступна).
    void logToolAction('scope_denied', { agency, tool });
    return {
      success: false,
      message: `SCOPE_DENIED: агентство "${agency}" не имеет доступа к инструменту "${tool}"`,
      details: { code: 'SCOPE_DENIED', agency, tool },
    };
  }

  switch (tool) {
    case 'sendBoardAlert':
      return sendBoardAlert(args[0] as string, args[1] as string, args[2] as string);
    case 'scanSQLErrors': {
      const report = scanSQLErrors();
      return { success: true, message: `Просканировано, файлов с ошибками: ${report.length}`, details: { report } };
    }
    default: {
      const exhaustive: never = tool;
      return { success: false, message: `Неизвестный инструмент: ${String(exhaustive)}` };
    }
  }
}

// ── Внутреннее логирование ────────────────────────────────────────────────────

async function logToolAction(
  actionType: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ai_actions_log (action_type, agent_name, metadata, result, created_at)
       VALUES ($1, 'board-executor-tools', $2, 'success', NOW())`,
      [actionType, JSON.stringify(metadata)]
    );
  } catch {
    // Логирование некритично — не прерываем основной поток
  }
}
