/**
 * Кого пускать к записи через публичный MCP (policy v3, аудит 07.09).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * Публичный MCP без авторизации — решение владельца, и оно остаётся: манифест
 * объявляет `"authentication": "none"`, чтение открыто. Но на записи стоял
 * счётчик в памяти процесса (`lib/rate-limit.ts`, `new Map`): он обнуляется
 * при каждом рестарте контейнера и не существует между инстансами. То есть
 * анонимный приём персональных данных удерживался ограничением, которого
 * фактически не было, — и по виду кода это выглядело защитой.
 *
 * ── Три вопроса, а не один ────────────────────────────────────────────────
 *
 * Решение собирается из трёх независимых проверок, и каждая ловит свой поток:
 *
 *   1. СОГЛАСИЕ. Анонимный клиент присылает чужой телефон и имя. Без явного
 *      согласия это приём ПД без основания. Раньше MCP не записывал согласие
 *      ВООБЩЕ — `buildConsentRecord` честно возвращал null («не спрашивали»),
 *      и это было верно как факт, но негодно как позиция.
 *
 *      ЧТО ЗДЕСЬ ОСТАЁТСЯ ДОЛГОМ, И ЭТО НАДО НАЗЫВАТЬ ДОЛГОМ. `consent: true`
 *      ставит АГЕНТ, а не человек: модель может прислать true, не показав
 *      человеку ни текста, ни ссылки на политику. Значит запись честно
 *      означает «агент утверждает, что согласие получено; версия текста
 *      такая-то; источник mcp» — и НЕ означает «человек поставил галочку».
 *      Для 152-ФЗ это основание слабее формы сайта. Закрывается это не
 *      полем, а мостом: когда появится первый внешний клиент, заявка должна
 *      уходить на страницу с той же галочкой, что на сайте, и согласие
 *      писаться оттуда. Мост уже есть под другую задачу — `issueMcpHandoff`.
 *      До тех пор пункт закрыт НАПОЛОВИНУ, и считать его закрытым нельзя.
 *   2. ЧАСТОТА С АДРЕСА. Поток заявок с одного клиента.
 *   3. ПОВТОР ТЕЛЕФОНА. Тот же номер с разных адресов — так выглядит и
 *      настоящая атака, и сломавшийся агент в цикле.
 *
 * ── Третий исход обязателен (§4.0) ────────────────────────────────────────
 *
 * У проверки три ответа: «можно», «нельзя» и «не смог проверить». Третий
 * ЗДЕСЬ не решает — решает вызывающий. Для анонимной записи ПД вызывающий
 * обязан читать «не смог» как отказ: пропустить непроверенное значит выдать
 * отсутствие проверки за её прохождение. Практически это ничего не теряет —
 * счёт живёт в той же базе, что и сам лид: не смогли посчитать, значит и
 * записать не смогли бы.
 *
 * ── Персональных данных в журнале нет ─────────────────────────────────────
 *
 * Ни телефона, ни имени, ни адреса — только необратимые отпечатки с секретной
 * солью. Защита от утечки ПД, сама ставшая вторым хранилищем ПД, — это не
 * защита.
 */

import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';

/** Окно и потолок на клиента: столько же, сколько держал счётчик в памяти. */
export const CLIENT_WINDOW_MINUTES = 10;
export const CLIENT_MAX_PER_WINDOW = 5;
/** Суточный потолок на клиента — от медленного равномерного потока. */
export const CLIENT_MAX_PER_DAY = 20;
/** Сколько заявок на ОДИН номер терпим за сутки. */
export const PHONE_MAX_PER_DAY = 3;

export type WriteOutcome = 'allowed' | 'rate_limited' | 'quarantined' | 'no_consent' | 'unknown';

export type WriteDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; outcome: Exclude<WriteOutcome, 'allowed' | 'unknown'>; message: string }
  | { decision: 'unknown'; message: string };

/**
 * Соль отпечатков — только своя переменная, без откатов.
 *
 * До 07.09 здесь был откат на CRON_SECRET, и он был оправдан ровно одним:
 * своей переменной ещё не существовало, а запретить запись до похода в
 * панель значило остановить рабочий путь. Теперь MCP_HASH_SALT заведена и
 * доехала до контейнера — подтверждено замером с прода, а не сообщением о
 * нажатой кнопке: `health` отдал `"mcp_hash_salt":true` (проба 453).
 *
 * Почему откат убран, а не оставлен «на всякий случай». Общий секрет
 * связывает две несвязанные вещи: поворот CRON_SECRET молча обнулял бы окно
 * лимита и карантин, а утечка одного секрета давала бы и запуск кронов, и
 * возможность перебрать прежние отпечатки адресов. Запасной путь, который
 * никогда не должен сработать, отличается от отсутствующего только тем, что
 * однажды срабатывает незаметно.
 *
 * Соли нет — отпечаток не строится и решение становится «не смог»
 * (вызывающий читает это как отказ). Считать без соли нельзя: sha256 от
 * адреса IPv4 перебирается за секунды и адресом же и остаётся.
 */
function salt(): string | null {
  return process.env.MCP_HASH_SALT || null;
}

function fingerprint(value: string, s: string): string {
  return createHash('sha256').update(`${s}:${value}`).digest('hex');
}

export interface WriteGuardInput {
  /** Адрес клиента как его видит роут. В журнал не попадает — только отпечаток. */
  ip: string;
  userAgent: string;
  tool: string;
  /** Нормализованный телефон. В журнал не попадает — только отпечаток. */
  phone: string | null;
  /** Прислал ли клиент явное согласие на обработку ПД. */
  consent: boolean;
}

interface Counts {
  by_client_window: number;
  by_client_day: number;
  by_phone_day: number;
}

/**
 * Решение по одной попытке записи. Ничего не пишет в лиды и ничего не
 * отправляет — только считает и объясняет.
 */
export async function checkMcpWrite(input: WriteGuardInput): Promise<WriteDecision> {
  const s = salt();
  const clientKey = s ? fingerprint(`${input.ip}|${input.userAgent}`, s) : null;
  const phoneHash = s && input.phone ? fingerprint(input.phone, s) : null;

  // Согласие спрашивается ПЕРВЫМ и не зависит ни от базы, ни от настроек.
  //
  // Порядок здесь не косметика. В первой редакции проверка соли стояла выше,
  // и в среде без соли отказ «нет согласия» подменялся ответом «не смог
  // посчитать поток»: агенту сообщали про нашу конфигурацию вместо того, что
  // от него требуется. Основание отказа обязано быть настоящим — иначе агент
  // будет чинить не то и повторять запрос, который никогда не пройдёт.
  //
  // Запись попытки при этом может не получиться (без соли отпечатка нет) —
  // решение от этого не меняется, а пропуск строки в журнале виден в логе.
  if (!input.consent) {
    if (clientKey) await record(clientKey, input.tool, phoneHash, 'no_consent');
    else console.error('[mcp-write-guard] отказ по согласию не записан: соль отпечатков не настроена');
    return {
      decision: 'deny',
      outcome: 'no_consent',
      message:
        'Заявка не создана: нет согласия на обработку персональных данных. '
        + 'Спросите человека прямо и передайте consent: true — без этого имя и телефон принимать нельзя.',
    };
  }

  if (!s || !clientKey) {
    return {
      decision: 'unknown',
      message: 'Соль отпечатков не настроена (MCP_HASH_SALT) — посчитать поток нечем.',
    };
  }

  // ── Считаем и записываем ПОД ЗАМКОМ, одной транзакцией ──────────────────
  //
  // Первая редакция считала запросом, а писала следующим — то самое
  // check-then-act, которое в этом репозитории уже чинили дважды
  // (recordPrEventOnce, idempotencyKey у code-merge-task). Три параллельных
  // create_lead с одним телефоном успевали посчитать ДО того, как хоть одна
  // строка коммитилась, и все три видели ноль. Лимит «после факта» на
  // параллели не работает вовсе, а именно параллелью и выглядит поток.
  //
  // Замки берутся в ОТСОРТИРОВАННОМ порядке: два клиента с одним телефоном
  // берут одни и те же два замка, и без общего порядка это классическая
  // взаимная блокировка. Пространства имён разные, чтобы отпечаток клиента
  // и отпечаток телефона не столкнулись случайным совпадением чисел.
  const locks: Array<[number, number]> = [[LOCK_NS_CLIENT, lockKey(clientKey)]];
  if (phoneHash) locks.push([LOCK_NS_PHONE, lockKey(phoneHash)]);
  locks.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [ns, key] of locks) {
      // xact-замок снимается коммитом или откатом сам — забыть его нельзя.
      await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [ns, key]);
    }

    // Приведения у параметров явные: форма «сравнение с колонкой внутри
    // FILTER» выводом типов не покрыта так же надёжно, как обычный WHERE,
    // а цена ошибки здесь — 42P08 на живом пути (случай 24.08 в CLAUDE.md).
    const { rows } = await client.query<{ a: string; b: string; c: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE client_key = $1::char(64)
                            AND created_at > NOW() - (INTERVAL '1 minute' * $3::int))::text AS a,
         COUNT(*) FILTER (WHERE client_key = $1::char(64))::text AS b,
         COUNT(*) FILTER (WHERE $2::char(64) IS NOT NULL AND phone_hash = $2::char(64))::text AS c
       FROM mcp_write_attempts
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
      [clientKey, phoneHash, String(CLIENT_WINDOW_MINUTES)],
    );
    const counts: Counts = {
      by_client_window: Number(rows[0]?.a ?? 0),
      by_client_day: Number(rows[0]?.b ?? 0),
      by_phone_day: Number(rows[0]?.c ?? 0),
    };

    const verdict = decide(counts);
    // Пишется ВСЯКИЙ исход, включая отказ, и пишется в той же транзакции,
    // что и счёт: иначе поток отказов не занимает слот и обходит лимит
    // повторением того, что уже отвергли.
    await client.query(
      `INSERT INTO mcp_write_attempts (client_key, tool, phone_hash, outcome)
       VALUES ($1::char(64), $2::varchar(64), $3::char(64), $4::varchar(16))`,
      [clientKey, input.tool, phoneHash, verdict.outcome],
    );
    await client.query('COMMIT');
    await sweepOld();
    return verdict.decision;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Молчать нельзя: отказ проверки, выданный за её прохождение, — ровно тот
    // дефект, ради которого §4.0 и написан.
    console.error('[mcp-write-guard] не смог посчитать поток:', err);
    return {
      decision: 'unknown',
      message: 'Не удалось проверить ограничения — заявка не создана. Повторите позже.',
    };
  } finally {
    client.release();
  }
}

/** Разные пространства: отпечаток клиента и отпечаток телефона не сталкиваются. */
const LOCK_NS_CLIENT = 1;
const LOCK_NS_PHONE = 2;

/** 32-разрядный ключ замка из отпечатка. Знак не важен — важна одинаковость. */
function lockKey(hash: string): number {
  return parseInt(hash.slice(0, 8), 16) | 0;
}

/** Решение по посчитанному. Отделено от ввода-вывода, чтобы читалось целиком. */
function decide(counts: Counts): { outcome: WriteOutcome; decision: WriteDecision } {
  if (counts.by_phone_day >= PHONE_MAX_PER_DAY) {
    return {
      outcome: 'quarantined',
      decision: {
        decision: 'deny',
        outcome: 'quarantined',
        message:
          `На этот номер уже ${counts.by_phone_day} заявки за сутки — новую не создаю. `
          + 'Если заявка настоящая, менеджер свяжется по предыдущей.',
      },
    };
  }
  if (counts.by_client_window >= CLIENT_MAX_PER_WINDOW || counts.by_client_day >= CLIENT_MAX_PER_DAY) {
    return {
      outcome: 'rate_limited',
      decision: {
        decision: 'deny',
        outcome: 'rate_limited',
        message: `Слишком много заявок подряд — подождите ${CLIENT_WINDOW_MINUTES} минут и повторите.`,
      },
    };
  }
  return { outcome: 'allowed', decision: { decision: 'allow' } };
}

/**
 * Уборка попутно и редко: счёт смотрит только на сутки, хранить год незачем,
 * а отдельный крон ради одной таблицы — лишняя сущность в реестре. Раз в
 * полсотни записей дешевле ежедневного прогона. Вне транзакции: замок под
 * удаление старья держать незачем.
 */
async function sweepOld(): Promise<void> {
  if (Math.random() >= 0.02) return;
  try {
    await pool.query(`DELETE FROM mcp_write_attempts WHERE created_at < NOW() - INTERVAL '30 days'`);
  } catch (err) {
    console.error('[mcp-write-guard] уборка журнала не прошла:', err);
  }
}

/**
 * Запись попытки ВНЕ транзакции решения — только для отказа по согласию.
 *
 * Остальные исходы пишутся внутри транзакции вместе со счётом: иначе отказ не
 * занимает слот. Отказу по согласию сериализация не нужна — он не зависит от
 * счёта и не может «проскочить» параллелью.
 *
 * Отказ самой записи не ломает решение — оно уже принято. Но и не глушится:
 * без строки в логе журнал, переставший писаться, выглядел бы как «попыток
 * не было».
 */
async function record(
  clientKey: string,
  tool: string,
  phoneHash: string | null,
  outcome: WriteOutcome,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO mcp_write_attempts (client_key, tool, phone_hash, outcome)
       VALUES ($1::char(64), $2::varchar(64), $3::char(64), $4::varchar(16))`,
      [clientKey, tool, phoneHash, outcome],
    );
  } catch (err) {
    console.error('[mcp-write-guard] не смог записать попытку:', err);
  }
}
