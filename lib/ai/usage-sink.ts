/**
 * lib/ai/usage-sink.ts
 *
 * Куда писать расход LLM, когда БД недостижима, — раннер GitHub.
 *
 * Судья эволюции (`scripts/evo-judge.ts`) и AI-ревью Growth Scan
 * (`scripts/evo-review.ts`) считают НЕ на проде: §8, «раннер GitHub — секреты
 * репозитория». Они же самые дорогие потребители платформы. А `logLLMUsage`
 * умел только прямой INSERT в `llm_usage_log` — при том что `DATABASE_URL` в их
 * workflow нет вовсе, и БД Timeweb с раннера закрыта файрволом (тот же барьер,
 * из-за которого дорожный граф строится на раннере, а принимается роутом на
 * проде). INSERT падал ВСЕГДА, отказ уходил в `console.error` лога прогона,
 * который никто не читает, и книги расхода оставались пустыми.
 *
 * Цена этой пустоты названа 19.09: `/api/cron/llm-budget-check` суммирует
 * `llm_usage_log`, значит по тратам раннера дневной бюджет не мог сработать ни
 * при каком `AI_DAILY_BUDGET_USD`. Баланс ключа Anthropic кончился без единого
 * предупреждения — не потому, что проверки не было, а потому что проверке
 * нечего было складывать.
 *
 * Адрес прода ЗАШИТ здесь, а не приходит переменной: §8, урок 08.08 —
 * «правило, зависящее от дисциплины заполняющего конфиг, — не защита». Тот же
 * приём, что в `evo-judge.yml`, где `https://vedarai.ru/...` стоит в самом
 * workflow, а не в параметре.
 *
 * Признак раннера — `GITHUB_ACTIONS`, переменная самого GitHub Actions, а не
 * наша. На проде её нет, значит прод по-прежнему пишет прямым INSERT и никуда
 * не звонит сам себе.
 */

const PROD_BASE = 'https://vedarai.ru';
const REPORT_PATH = '/api/admin/llm-usage/report';

export interface UsageRowToReport {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  agent_id: string | null;
}

/**
 * Писать ли расход через прод вместо прямого INSERT.
 *
 * Оба условия обязательны и оба — факты, а не настройки: мы на раннере, и нам
 * есть чем авторизоваться. Нет секрета — остаётся прямой INSERT, который
 * упадёт и скажет об этом вслух; это честнее, чем тихо не записать ничего.
 */
export function usageSinkEnabled(): boolean {
  return process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.CRON_SECRET);
}

/**
 * Отправляет строки расхода на прод. Возвращает, приняты ли ВСЕ.
 *
 * Цену здесь не считаем и не посылаем — её считает сервер: строка в книгах не
 * должна быть утверждением звонящего о собственных расходах. Посылаем только
 * то, что сказал провайдер: имя модели и токены.
 *
 * Никогда не бросает: учёт не должен ронять работу, ради которой он ведётся.
 * Но и молчать не может — отказ уходит в `console.error` с причиной (§4.0).
 */
export async function sendUsageToProd(rows: UsageRowToReport[]): Promise<boolean> {
  if (rows.length === 0) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[llm-usage-sink] CRON_SECRET не задан — расход раннера в книги не попадёт');
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${PROD_BASE}${REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ rows }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[llm-usage-sink] прод не принял расход: HTTP ${res.status} ${detail.slice(0, 200)}`);
      return false;
    }
    // 207 — часть строк прод записать не смог, и это не успех: он сам называет
    // обе цифры, и «частично» не должно читаться как «записано».
    if (res.status === 207) {
      const detail = await res.text().catch(() => '');
      console.error(`[llm-usage-sink] прод записал не всё: ${detail.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[llm-usage-sink] расход не отправлен:', e instanceof Error ? e.message : e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
