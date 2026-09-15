/**
 * Operator Outreach Executor — автономный поиск операторов + Telegram-уведомления.
 *
 * Flow:
 *   1. Fetch RSS-лент rata-news.ru и tourprom.ru
 *   2. AI извлекает названия операторов, email, сайты
 *   3. INSERT в outreach_queue (skip если такой уже есть) — статус 'found'
 *   4. ОТДЕЛЬНОЙ фазой: всё, что стоит в 'found', объявляется в Telegram
 *      и переводится в 'contacted' — включая застрявшее с прошлых прогонов
 *
 * ПОЧЕМУ ДВЕ ФАЗЫ, А НЕ ТРАНЗАКЦИЯ (находка Evo Judge 15.09).
 * Раньше INSERT, отправка в Telegram и UPDATE шли подряд на каждом операторе.
 * Между ними стоит ЧУЖОЙ HTTP-вызов, и любой отказ на нём оставлял строку в
 * статусе 'found' — а дедуп следующего прогона (`NOT EXISTS` по email/имени)
 * такую строку исключает. То есть оператор, о котором не удалось сообщить,
 * не объявлялся уже НИКОГДА: молча, без ошибки, без второй попытки.
 *
 * Транзакция это не лечит и лечить не может: отправленное в Telegram
 * сообщение откатом не возвращается, а держать транзакцию открытой поверх
 * внешнего HTTP — держать блокировку на время чужого таймаута. Лечит
 * ПОВТОРНАЯ ПОПЫТКА: объявление привязано не к «только что вставили», а к
 * состоянию строки, и застрявшее подхватывается следующим прогоном.
 *
 * Порядок «сначала отправить, потом записать» выбран сознательно: он даёт
 * доставку не реже одного раза (в худшем случае — повтор сообщения
 * администратору, это шум). Обратный порядок дал бы не чаще одного раза —
 * то есть потерю оператора при падении сразу после UPDATE, а это ровно та
 * поломка, которую здесь чинят.
 */

import { pool } from '@/lib/db-pool';
import { callAIFast, isWaterfallErrorResponse } from '@/lib/ai/providers';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import type { ChatMessage } from '@/lib/ai/prompts';

// Локальные типы — избегаем циклического импорта из initiative-executor
export interface ExecutionTask {
  approval_id: string;
  executor_agent_id: string;
  action_type: string;
  description: string;
  context: Record<string, unknown>;
  due_date: string;
}

export interface ExecutionResult {
  success: boolean;
  changes_made: string[];
  errors: string[];
  rollback_available: boolean;
  verification_passed: boolean;
}

interface FoundOperator {
  company_name: string;
  email?: string;
  website?: string;
  source: string;
}

const RSS_SOURCES = [
  { url: 'https://www.rata-news.ru/feed/',  source: 'rata-news' },
  { url: 'https://tourprom.ru/news/rss/',   source: 'tourprom'  },
];

/** Fetch RSS-ленту, вернуть raw XML/text (не бросает) */
async function fetchRSS(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'KamchatourHub-Bot/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** AI извлечение операторов из RSS-контента */
async function extractOperatorsFromContent(content: string, sourceName: string): Promise<FoundOperator[]> {
  const truncated = content.length > 8000 ? content.slice(0, 8000) + '...(truncated)' : content;

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Ты извлекаешь туроператоров Камчатки из RSS-контента туристических новостей. ' +
        'Оператор — компания, которая САМА организует и продаёт туры на Камчатку. НЕ включай: СМИ и новостные издания, отраслевые ассоциации, госорганы, агрегаторы, блогеров, частных лиц.\n' +
        'СТРОГО ПРОТИВ ВЫДУМЫВАНИЯ: бери ТОЛЬКО данные, которые буквально присутствуют в тексте. ' +
        'НИКОГДА не достраивай, не угадывай и не генерируй email или website по названию компании или по шаблону. ' +
        'Если email или website не указаны в тексте дословно — пропусти соответствующее поле. ' +
        'Не нормализуй и не «исправляй» адреса — копируй как есть.\n' +
        'Верни ТОЛЬКО JSON-массив без пояснений и без markdown-ограждения.\n' +
        'Формат: [{"company_name":"...","email":"...","website":"..."}]\n' +
        'company_name указывай дословно как в тексте. ' +
        'Если в контенте нет ни одного подходящего оператора — верни []. Пустой ответ лучше выдуманного.',
    },
    {
      role: 'user',
      content: `Источник: ${sourceName}\n\nКонтент RSS:\n${truncated}`,
    },
  ];

  // Водопад, а не единственный провайдер (находка судьи эволюции 08.09):
  // прежний прямой вызов не имел фолбэка, и отказ одной модели ронял
  // разбор RSS-источника целиком — то есть очередь операторов молча
  // недосчитывалась ленты. CLAUDE.md прямо это запрещает: прямые вызовы
  // живут только в providers.ts и health-пробах.
  const raw = await callAIFast(messages);
  if (!raw || isWaterfallErrorResponse(raw)) {
    logSwallowedFailure('operator-outreach', `разбор ленты ${sourceName}`,
      new Error(raw ? raw.slice(0, 200) : 'пустой ответ водопада'));
    return [];
  }

  // Парсим JSON-ответ
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({
      company_name: typeof item.company_name === 'string' ? item.company_name.trim() : '',
      email:        typeof item.email        === 'string' ? item.email.trim()        : undefined,
      website:      typeof item.website      === 'string' ? item.website.trim()      : undefined,
      source:       sourceName,
    }))
    .filter(op => op.company_name.length > 2);
}

/**
 * Исход отправки — три состояния, а не два (§4.0).
 *
 * `not_configured` («некому слать») и `failed` («не дошло») прежде возвращались
 * одинаковым `false`, и вызывающий не мог их различить: строка молча оставалась
 * в очереди, а прогон считался успешным. Это разные состояния и разные слова
 * человеку: первое чинится переменными окружения, второе — повтором.
 */
type SendOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'failed'; detail: string };

/** Отправить Telegram-сообщение о найденном операторе с готовым текстом для контакта */
async function sendOperatorToTelegram(op: FoundOperator, outreachId: string): Promise<SendOutcome> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return { ok: false, reason: 'not_configured' };

  const inviteText = [
    `Здравствуйте, коллеги из ${op.company_name}.`,
    '',
    'Пишем вам от платформы KamchatourHub (TourHab) — каталога туров по Камчатке с акцентом на безопасность туристов.',
    '',
    'Предлагаем разместить ваши туры. Что это даёт оператору:',
    '- Дополнительный канал заявок от туристов, ищущих туры на Камчатку',
    '- AI-ассистент Кузьмич помогает обрабатывать обращения',
    '- Уведомления и учёт бронирований в едином кабинете',
    '- Размещение туров — бесплатно',
    '',
    'Если интересно, регистрация здесь: https://vedarai.ru/register',
    'Готовы ответить на любые вопросы.',
    '',
    'С уважением, команда KamchatourHub',
  ].join('\n');

  const tgText = [
    '<b>Новый оператор для контакта</b>',
    '',
    `<b>Компания:</b> ${op.company_name}`,
    op.website ? `<b>Сайт:</b> ${op.website}` : '',
    op.email   ? `<b>Email:</b> ${op.email}`   : '',
    `<b>Источник:</b> ${op.source}`,
    `<b>ID в очереди:</b> <code>${outreachId.substring(0, 8)}</code>`,
    '',
    '<b>Готовый текст для отправки оператору:</b>',
    `<code>${inviteText}</code>`,
  ].filter(l => l !== '').join('\n');

  // Сетевой отказ здесь — тоже «не дошло», а не исключение наружу: цикл
  // объявления обязан дойти до остальных операторов очереди.
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    chatId,
        parse_mode: 'HTML',
        text:       tgText,
        disable_web_page_preview: true,
      }),
    });

    if (res.ok) return { ok: true };

    const body = await res.text().catch(() => '');
    const detail = `HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`;
    logSwallowedFailure('operator-outreach', `Telegram о «${op.company_name}»`, new Error(detail));
    return { ok: false, reason: 'failed', detail };
  } catch (err) {
    logSwallowedFailure('operator-outreach', `Telegram о «${op.company_name}»`, err);
    return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Сколько строк объявляем за прогон. Граница нужна не базе, а человеку:
 * очередь, простоявшая необъявленной, не должна вываливаться в Telegram
 * сотней сообщений разом. Остаток подхватит следующий прогон — он для того
 * и отвязан от «только что вставили».
 */
const ANNOUNCE_LIMIT = 50;

export async function executeOperatorOutreach(task: ExecutionTask): Promise<ExecutionResult> {
  const changes: string[] = [];
  const errors:  string[] = [];

  let foundCount    = 0;
  let insertedCount = 0;
  let notifiedCount = 0;

  for (const rssSource of RSS_SOURCES) {
    try {
      // ── Step 1: Fetch RSS ─────────────────────────────────────────────────
      const rssContent = await fetchRSS(rssSource.url);
      changes.push(`RSS получен: ${rssSource.source} (${Math.round(rssContent.length / 1024)}KB)`);

      // ── Step 2: AI extracts operators ─────────────────────────────────────
      const operators = await extractOperatorsFromContent(rssContent, rssSource.source);
      foundCount += operators.length;

      if (operators.length === 0) {
        changes.push(`${rssSource.source}: операторы не найдены`);
        continue;
      }

      changes.push(`${rssSource.source}: найдено ${operators.length} операторов`);

      for (const op of operators) {
        try {
          // ── Step 3: INSERT (skip if already in queue by company name or email) ──
          //
          // Здесь стояло `ON CONFLICT (email) DO NOTHING`, и запрос не
          // выполнялся НИКОГДА (находка Evo Judge 13.09, разобрана 13.09).
          // `ON CONFLICT (col)` требует УНИКАЛЬНОГО индекса по col, чтобы
          // вывести арбитра; у `outreach_queue` индекс по email обычный
          // (миграция 115: `CREATE INDEX ... WHERE email IS NOT NULL`, без
          // UNIQUE — сверено со схемой прода, docs/DB_SCHEMA.md: три индекса,
          // уникального среди них нет). Ответ сервера — 42P10 «there is no
          // unique or exclusion constraint matching the ON CONFLICT
          // specification», на КАЖДОМ операторе, а `catch (opErr)` ниже
          // складывал его в errors[] — отчёт был, читателя не было.
          //
          // Тот же род, что случай 24.08 в CLAUDE.md §4: запрос формы
          // «вставь, если такого ещё нет», который не выполняется никогда.
          // Поэтому и лечится он так же — явной проверкой NOT EXISTS, а не
          // новым уникальным индексом: индекс пришлось бы накатывать
          // миграцией на живую таблицу, и при существующих дублях
          // `CREATE UNIQUE INDEX` уронил бы деплой (миграции идут в start.js
          // до подъёма сервера).
          //
          // Приведения `::varchar` у КАЖДОГО параметра в списке SELECT
          // обязательны: без якоря типа эта форма отвечает 42P08, и запрос
          // снова не выполнялся бы никогда. Запрос внесён в реестр
          // app/api/cron/sql-shape-check — приговор выносит PREPARE на проде.
          //
          // Заодно исполнено то, что обещал комментарий: пропуск по email
          // ИЛИ по имени компании. Прежний ON CONFLICT про имя не знал вовсе,
          // а у оператора без email (email IS NULL) арбитра нет по смыслу —
          // NULL в уникальном индексе не конфликтует сам с собой.
          const insertResult = await pool.query<{ id: string }>(
            `INSERT INTO outreach_queue (company_name, email, website, source, status)
             SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, 'found'
              WHERE NOT EXISTS (
                SELECT 1 FROM outreach_queue
                 WHERE ($2::varchar IS NOT NULL AND lower(email) = lower($2::varchar))
                    OR ($2::varchar IS NULL AND lower(company_name) = lower($1::varchar))
              )
             RETURNING id`,
            [op.company_name, op.email ?? null, op.website ?? null, op.source]
          );

          if (!insertResult.rows[0]) continue; // уже в очереди

          insertedCount++;
          changes.push(`В очередь добавлен: ${op.company_name}${op.email ? ` <${op.email}>` : ''}`);

          // Объявления здесь НЕТ намеренно — оно идёт отдельной фазой ниже,
          // по состоянию строки. См. шапку файла.

        } catch (opErr) {
          errors.push(`"${op.company_name}": ${opErr instanceof Error ? opErr.message : String(opErr)}`);
        }
      }

    } catch (rssErr) {
      errors.push(`RSS ${rssSource.source}: ${rssErr instanceof Error ? rssErr.message : String(rssErr)}`);
    }
  }

  // ── Step 4: объявить всё, что стоит в 'found' ───────────────────────────────
  //
  // Отбор по СОСТОЯНИЮ, а не по «только что вставили»: сюда попадает и то,
  // что застряло на прошлых прогонах (отправка не дошла, процесс упал между
  // отправкой и записью). Без этой фазы такая строка не объявлялась бы
  // никогда — дедуп выше её исключает по построению.
  let notAnnouncedCount = 0;
  let notConfigured     = false;
  let pendingTotal      = 0;

  try {
    const pending = await pool.query<{
      id: string; company_name: string; email: string | null; website: string | null; source: string | null;
    }>(
      `SELECT id, company_name, email, website, source
         FROM outreach_queue
        WHERE status = 'found'
        ORDER BY created_at ASC
        LIMIT $1`,
      [ANNOUNCE_LIMIT]
    );
    pendingTotal = pending.rows.length;

    for (const row of pending.rows) {
      const op: FoundOperator = {
        company_name: row.company_name,
        email:        row.email   ?? undefined,
        website:      row.website ?? undefined,
        source:       row.source  ?? 'неизвестен',
      };

      const sent = await sendOperatorToTelegram(op, row.id);

      if (!sent.ok) {
        notAnnouncedCount++;
        if (sent.reason === 'not_configured') {
          notConfigured = true;
        } else {
          // Отказ доставки — ошибка прогона, а не тишина: строка остаётся в
          // 'found' и будет объявлена следующим прогоном, но знать об этом
          // человек должен сейчас (§4.0).
          errors.push(`Telegram о "${row.company_name}": ${sent.detail}`);
        }
        continue;
      }

      // `AND status = 'found'` — перепроверка того же рода, что в archive_sos:
      // между отбором и записью статус мог сменить администратор из панели
      // (/api/admin/outreach PATCH), и затирать его решение словом 'contacted'
      // нельзя. RETURNING — чтобы счётчик называл ФАКТ записи, а не намерение.
      const marked = await pool.query<{ id: string }>(
        `UPDATE outreach_queue
            SET status        = 'contacted',
                outreach_text = 'Telegram-уведомление отправлено администратору',
                contacted_at  = NOW(),
                updated_at    = NOW()
          WHERE id = $1
            AND status = 'found'
        RETURNING id`,
        [row.id]
      );

      if (marked.rows[0]) {
        notifiedCount++;
        changes.push(`Telegram отправлен: ${row.company_name}${row.email ? ` <${row.email}>` : ''}`);
      } else {
        changes.push(`Статус "${row.company_name}" изменён за время прогона — отметку не ставлю`);
      }
    }
  } catch (announceErr) {
    logSwallowedFailure('operator-outreach', 'объявление очереди', announceErr);
    errors.push(`Объявление очереди: ${announceErr instanceof Error ? announceErr.message : String(announceErr)}`);
  }

  if (notConfigured) {
    changes.push('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — объявлять некуда, очередь ждёт');
  }
  if (notAnnouncedCount > 0) {
    changes.push(`Осталось необъявленных: ${notAnnouncedCount} — подхватит следующий прогон`);
  }

  // ── Telegram итоговый отчёт ─────────────────────────────────────────────────
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId && (foundCount > 0 || pendingTotal > 0 || errors.length > 0)) {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        parse_mode: 'HTML',
        text: [
          '<b>Operator Outreach — итог</b>',
          '',
          `Найдено операторов: <b>${foundCount}</b>`,
          `Добавлено в очередь: <b>${insertedCount}</b>`,
          `Уведомлений отправлено: <b>${notifiedCount}</b>`,
          // Необъявленное называется вслух: это очередь, которая ждёт, а не
          // ноль работы. Молчание о ней и было прежней поломкой.
          ...(notAnnouncedCount > 0 ? [`Осталось необъявленных: <b>${notAnnouncedCount}</b>`] : []),
          errors.length > 0 ? `Ошибок: ${errors.length}` : 'Ошибок нет',
          '',
          '<i>Каждый новый оператор — отдельное сообщение выше с готовым текстом</i>',
        ].join('\n'),
      }),
    }).catch(() => null);
  }

  changes.push(
    `Итого: найдено ${foundCount}, добавлено ${insertedCount}, ` +
    `объявлено ${notifiedCount} из ${pendingTotal} ожидавших`
  );

  return {
    success:             errors.length === 0 || insertedCount > 0,
    changes_made:        changes,
    errors,
    rollback_available:  false,
    // Не «всегда true» (§4.0): дело доведено до конца только если очередь
    // объявлена целиком. Осталось необъявленное — проверка не пройдена, и
    // писать обратное значит выдавать «не смог» за «хорошо».
    verification_passed: notAnnouncedCount === 0 && errors.length === 0,
  };
}
