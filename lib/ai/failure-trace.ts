/**
 * След отказа быстрой ветки: КТО не ответил и ПОЧЕМУ.
 *
 * Повод (23.08). Scout сообщал `judge_unavailable` — «не ответил ни один
 * провайдер, чинить у провайдера». Владелец проверил: DEEPSEEK_API_KEY на
 * Timeweb стоит. Дальше диагностика кончалась, потому что кончался код: в
 * `callAIFast` четыре ноги гонки, и КАЖДАЯ приводит любой свой отказ к
 * одному и тому же `null` — `catch { return null }`. Нет ключа, 401, 402,
 * таймаут, пустой ответ — снаружи неразличимо.
 *
 * Это ровно §4.0 CLAUDE.md на своём же коде: проверка без исхода «не смог»
 * отвечает «не ответил никто» и умолкает. Совет «чинить у провайдера» при
 * этом верен ровно настолько же, насколько бесполезен — какого провайдера
 * и что именно чинить, он не говорит.
 *
 * Здесь ноги оставляют причину. Кольцо на несколько записей, в памяти
 * процесса: это диагностика последнего прогона, а не журнал. Секретам сюда
 * попасть нельзя — текст ответа провайдера чистится от ключей.
 */

export interface AiLegFailure {
  provider: string;
  /** no_key | http_<код> | empty | timeout | <имя ошибки> */
  reason: string;
  at: number;
}

const RING_SIZE = 12;
const ring: AiLegFailure[] = [];

/** Ключи в тексте ошибки провайдера. Показывать их нельзя даже в диагностике. */
function stripSecrets(s: string): string {
  return s
    .replace(/\b(?:sk|xai|gsk|key)[-_][A-Za-z0-9_-]{8,}/gi, '<ключ скрыт>')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <ключ скрыт>');
}

export function recordAiLegFailure(provider: string, reason: string): void {
  ring.push({ provider, reason: stripSecrets(reason).slice(0, 120), at: Date.now() });
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

/** Причина отказа по HTTP-ответу: код плюс начало тела, если оно что-то говорит. */
export function httpFailureReason(status: number, body?: string): string {
  const tail = body?.trim() ? ` ${stripSecrets(body.trim()).slice(0, 80)}` : '';
  return `http_${status}${tail}`;
}

/** Причина отказа по исключению: имя, а не весь стек. */
export function errorFailureReason(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message)) return 'timeout';
    return stripSecrets(`${e.name}: ${e.message}`).slice(0, 120);
  }
  return stripSecrets(String(e)).slice(0, 120);
}

/**
 * Отказы за последние `windowMs`. Пусто — не «всё хорошо», а «следа нет»:
 * либо никто не звал, либо процесс перезапустился. Вызывающий обязан
 * различать это сам.
 */
export function recentAiFailures(windowMs = 120_000): AiLegFailure[] {
  const since = Date.now() - windowMs;
  return ring.filter((f) => f.at >= since);
}

/** Одна строка для алерта: «deepseek: http_402; gemini: timeout». */
export function describeRecentAiFailures(windowMs = 120_000): string | null {
  const recent = recentAiFailures(windowMs);
  if (recent.length === 0) return null;
  const byProvider = new Map<string, string>();
  for (const f of recent) byProvider.set(f.provider, f.reason);
  return [...byProvider].map(([p, r]) => `${p}: ${r}`).join('; ');
}

/**
 * Форма ПУСТОГО ответа chat/completions — чтобы «пусто» называло, что пришло.
 *
 * Повод (04.09, ai-debug run 4). DeepSeek ответил HTTP 200 за 313 мс с
 * пустым `content` — и все три пути (чат, судья, решатель) записали одно
 * слово «empty». Тело при этом никто не сохранил, и на вопрос «модель
 * думала и не договорила, сработал фильтр, или в теле лежит error под 200»
 * ответить было нечем. Тот же дефект, что и у молчаливого `null` (см. шапку):
 * исход «не смог» есть, но он не говорит, ЧТО получил.
 *
 * Здесь — только форма: finish_reason, поля message, длина reasoning_content,
 * либо error в теле. Текст ответа не показывается — его нет, потому и зовут.
 */
export function describeEmptyCompletion(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return `тело не объект: ${stripSecrets(JSON.stringify(data) ?? String(data)).slice(0, 80)}`;
  }
  const d = data as {
    error?: unknown;
    choices?: Array<{ finish_reason?: unknown; message?: Record<string, unknown> | null }>;
  };
  if (d.error !== undefined && d.error !== null) {
    return `error в теле под 200: ${stripSecrets(JSON.stringify(d.error)).slice(0, 120)}`;
  }
  const choice = Array.isArray(d.choices) ? d.choices[0] : undefined;
  if (!choice) return `choices пуст; ключи тела: ${Object.keys(d).join(',') || '—'}`;
  const msg = choice.message && typeof choice.message === 'object' ? choice.message : {};
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content.length : 0;
  const fields = Object.keys(msg).join(',') || '—';
  return `finish_reason=${String(choice.finish_reason ?? '—')}; поля message: ${fields}; reasoning_content: ${reasoning} зн.`;
}
