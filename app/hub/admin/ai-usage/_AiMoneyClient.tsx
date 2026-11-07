'use client';

/**
 * Вкладка «Деньги» страницы «Расходы AI» — первая и открывается сама.
 *
 * Владелец 07.11: «объясни, где что и как смотреть расходы и за что», затем
 * «наведи порядок в этом разделе». До этого дня деньги жили карточкой в
 * «Health-метриках», а «Расходы AI» показывали счётчик действий и блок
 * «стоимость пока не пишется» — по колонке ai_actions_log.cost_usd, которую не
 * пишет никто, при живых книгах llm_usage_log рядом.
 *
 * Порядок на экране — от вопроса владельца:
 *   1. Сутки против дневного лимита: та же переменная AI_DAILY_BUDGET_USD и
 *      та же граница суток, что у тревоги о бюджете; «лимит не задан» сказано
 *      словами, а не выдано за «без лимита».
 *   2. За что — расход по агентам за 24 ч / 7 / 30 дней.
 *   3. По моделям — тем же окном.
 *   4. Остаток на счетах провайдеров.
 *   5. Чего здесь нет: сессии разработки (Claude Code) — их счёт у Anthropic.
 *
 * Цена — оценка по каталогу; вызовы без цены названы отдельно и в сумму не
 * входят (§4.0: «дёшево» и «не посчитано» различаются). Типы объявлены здесь,
 * а не импортом из lib/ai: клиентский компонент не тянет цепочку до
 * providers.ts.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Wallet } from 'lucide-react';
import { plural } from '@/lib/home/data-freshness';

interface ProviderBalance {
  id: string;
  label: string;
  status: 'ok' | 'no_key' | 'unsupported' | 'failed';
  amount: number | null;
  currency: string | null;
  detail: string;
}
interface SpendWindow {
  calls: number;
  tokens: number;
  cost_usd: number | null;
  unknown_cost_calls: number;
}
interface ModelSpend {
  model: string;
  provider_guess: string;
  d1: SpendWindow;
  d7: SpendWindow;
  d30: SpendWindow;
}
interface AgentSpend {
  agent_id: string | null;
  label: string;
  d1: SpendWindow;
  d7: SpendWindow;
  d30: SpendWindow;
}
type DailyLimit = { kind: 'set'; usd: number } | { kind: 'unset' } | { kind: 'invalid' };
interface SpendToday {
  since: string;
  calls: number;
  cost_usd: number;
  unpriced_calls: number;
}
export interface AiMoney {
  balances: ProviderBalance[];
  spend: ModelSpend[];
  by_agent: AgentSpend[];
  budget: { limit: DailyLimit; today: SpendToday };
  checked_at: string;
}

const BALANCE_STATUS_LABEL: Record<ProviderBalance['status'], string> = {
  ok: 'остаток',
  no_key: 'ключа нет',
  unsupported: 'API не отдаёт',
  failed: 'не смог спросить',
};

const usd = (v: number): string => `$${v.toFixed(v < 1 ? 4 : 2)}`;

function fmtUsd(w: SpendWindow): string {
  if (w.calls === 0) return '—';
  const cost = w.cost_usd === null ? 'цена не посчитана' : usd(w.cost_usd);
  return w.unknown_cost_calls > 0 && w.cost_usd !== null ? `${cost} +${w.unknown_cost_calls} без цены` : cost;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Начало суток тревоги о бюджете — по Камчатке, словами. */
function sinceKamchatka(iso: string): string | null {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', {
    timeZone: 'Asia/Kamchatka', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

function StatusDot({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 className="w-4 h-4 shrink-0 text-[var(--success)]" aria-label="в порядке" />
    : <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--warning)]" aria-label="внимание" />;
}

/** Сутки против лимита: три исхода лимита и вызовы без цены — словами. */
function TodayBlock({ budget }: { budget: AiMoney['budget'] }) {
  const { limit, today } = budget;
  const spent = usd(today.cost_usd);
  const since = sinceKamchatka(today.since);
  const over = limit.kind === 'set' && today.cost_usd > limit.usd;
  let main: string;
  if (limit.kind === 'set') {
    main = over
      ? `Лимит превышен: ${spent} при лимите ${usd(limit.usd)} на сутки. Тревога уходит в Telegram — проверка раз в час.`
      : `${spent} из лимита ${usd(limit.usd)} на сутки. Превысит — придёт тревога в Telegram (проверка раз в час).`;
  } else if (limit.kind === 'unset') {
    main = `${spent} за сутки. Дневной лимит не задан — перерасход никто не сторожит. `
      + 'Задаётся переменной AI_DAILY_BUDGET_USD (в долларах) в настройках приложения на Timeweb.';
  } else {
    main = `${spent} за сутки. AI_DAILY_BUDGET_USD задан, но это не число больше нуля — лимит не работает.`;
  }
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4" aria-labelledby="ai-money-today">
      <div className="flex items-center gap-2 mb-2">
        <StatusDot ok={limit.kind === 'set' && !over} />
        <h2 id="ai-money-today" className="text-sm font-semibold text-[var(--text-primary)]">Сегодня</h2>
      </div>
      <p className="text-sm text-[var(--text-primary)]">{main}</p>
      <p className="text-xs text-[var(--text-muted)] mt-1.5">
        {today.calls.toLocaleString('ru-RU')} {plural(today.calls, 'вызов', 'вызова', 'вызовов')} модели
        {today.unpriced_calls > 0 ? `, из них ${today.unpriced_calls} без цены — в сумму не вошли` : ''}.
        {since ? ` Сутки — с ${since} по Камчатке, как у тревоги о бюджете.` : ''}
      </p>
    </section>
  );
}

function SpendTable({ caption, first, rows }: {
  caption: string;
  first: string;
  rows: Array<{ key: string; name: string; hint?: string; d1: SpendWindow; d7: SpendWindow; d30: SpendWindow }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-[var(--text-muted)]">
            <th scope="col" className="py-1 pr-3 font-medium">{first}</th>
            <th scope="col" className="py-1 pr-3 font-medium whitespace-nowrap">24 ч</th>
            <th scope="col" className="py-1 pr-3 font-medium whitespace-nowrap">7 дн</th>
            <th scope="col" className="py-1 pr-3 font-medium whitespace-nowrap">30 дн</th>
            <th scope="col" className="py-1 font-medium whitespace-nowrap">Вызовы и токены, 30 дн</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-[var(--border)] text-[var(--text-secondary)]">
              <td className="py-1.5 pr-3">
                <span className="text-[var(--text-primary)]">{r.name}</span>
                {r.hint && <span className="text-[var(--text-muted)]"> · {r.hint}</span>}
              </td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmtUsd(r.d1)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmtUsd(r.d7)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmtUsd(r.d30)}</td>
              <td className="py-1.5 whitespace-nowrap">{r.d30.calls.toLocaleString('ru-RU')} выз. · {fmtTokens(r.d30.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Содержимое вкладки по уже загруженным данным — его же рисует тест. */
export function AiMoneyView({ data }: { data: AiMoney }) {
  const withApi = data.balances.filter((b) => b.status !== 'unsupported');
  const unsupported = data.balances.filter((b) => b.status === 'unsupported');
  return (
    <div className="space-y-4">
      <TodayBlock budget={data.budget} />

      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4" aria-labelledby="ai-money-agents">
        <h2 id="ai-money-agents" className="text-sm font-semibold text-[var(--text-primary)] mb-1">За что — по агентам</h2>
        <p className="text-xs text-[var(--text-secondary)] mb-3">
          Кто потратил — по подписи агента в журнале вызовов модели. Дороже — выше.
          Вызовы не из подписанного агента — строка «без подписи»: кто их сделал, журнал не знает.
        </p>
        {data.by_agent.length === 0
          ? <p className="text-xs text-[var(--text-muted)]">За 30 дней в журнале нет ни одного вызова модели.</p>
          : <SpendTable caption="Расход по агентам" first="Кто" rows={data.by_agent.map((a) => ({
              key: a.agent_id ?? '—', name: a.label, d1: a.d1, d7: a.d7, d30: a.d30,
            }))} />}
      </section>

      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4" aria-labelledby="ai-money-models">
        <h2 id="ai-money-models" className="text-sm font-semibold text-[var(--text-primary)] mb-1">По моделям</h2>
        <p className="text-xs text-[var(--text-secondary)] mb-3">
          Цена — оценка по прайсу. «Без цены» — модели нет в нашем прайсе, эти вызовы в сумму не вошли.
        </p>
        {data.spend.length === 0
          ? <p className="text-xs text-[var(--text-muted)]">За 30 дней в журнале нет ни одного вызова с токенами.</p>
          : <SpendTable caption="Расход по моделям" first="Модель" rows={data.spend.map((m) => ({
              key: m.model, name: m.model, hint: m.provider_guess, d1: m.d1, d7: m.d7, d30: m.d30,
            }))} />}
      </section>

      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-4" aria-labelledby="ai-money-balances">
        <div className="flex items-center gap-2 mb-1">
          <Wallet className="w-4 h-4 text-[var(--text-muted)]" />
          <h2 id="ai-money-balances" className="text-sm font-semibold text-[var(--text-primary)]">Остаток на счетах</h2>
        </div>
        <p className="text-xs text-[var(--text-secondary)] mb-3">
          Остаток — на весь счёт провайдера, по моделям его не делят.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {withApi.map((b) => (
            <div key={b.id} className="flex items-start gap-2 p-2.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)]">
              <StatusDot ok={b.status === 'ok'} />
              <div className="min-w-0">
                <p className="text-xs font-medium text-[var(--text-primary)]">
                  {b.label}:{' '}
                  {b.status === 'ok' && b.amount !== null
                    ? <span className="font-semibold">{b.amount.toFixed(2)} {b.currency}</span>
                    : <span className={b.status === 'ok' ? '' : 'text-[var(--warning)]'}>{BALANCE_STATUS_LABEL[b.status]}</span>}
                </p>
                <p className="text-xs text-[var(--text-muted)] break-words">{b.detail}</p>
              </div>
            </div>
          ))}
        </div>
        {unsupported.length > 0 && (
          <details className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
            <summary className="text-xs font-medium text-[var(--text-primary)] cursor-pointer">
              Без API баланса: {unsupported.length} {plural(unsupported.length, 'провайдер', 'провайдера', 'провайдеров')} — остаток только в их кабинетах
            </summary>
            <div className="mt-2 space-y-1">
              {unsupported.map((b) => (
                <p key={b.id} className="text-xs text-[var(--text-muted)] break-words">
                  <span className="text-[var(--text-secondary)]">{b.label}</span> · {b.detail}
                </p>
              ))}
            </div>
          </details>
        )}
      </section>

      <p className="text-xs text-[var(--text-muted)]">
        Здесь не видно: сессии разработки в Claude Code — их счёт в вашем кабинете Anthropic, в журнал платформы они не пишутся.
      </p>
    </div>
  );
}

export default function AiMoneyClient() {
  const [data, setData] = useState<AiMoney | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Загрузка — цепочкой прямо в эффекте (как useHealth в «Health-метриках»):
  // состояние меняется только после ответа сети, ушедший ответ не перетирает
  // свежий, а «Обновить» перезапускает эффект ключом.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/health/ai-money')
      .then(async (res) => {
        const json = (await res.json()) as { success?: boolean; data?: AiMoney; error?: string };
        if (cancelled) return;
        if (res.ok && json.success && json.data) {
          setData(json.data);
          setError(null);
        } else {
          setError(json.error ?? `Деньги на ИИ не загрузились: HTTP ${res.status}`);
        }
      })
      .catch(() => { if (!cancelled) setError('Деньги на ИИ не загрузились: сеть не ответила'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          Сколько стоит ИИ платформы: сегодня против лимита, кто потратил, какими моделями и сколько осталось на счетах.
        </p>
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md hover:bg-[var(--bg-hover)] transition-colors shrink-0"
        >
          <RefreshCw className="w-3 h-3" /> Обновить
        </button>
      </div>
      {loading && !data && <div className="ds-skeleton h-24 rounded-lg" />}
      {error && (
        <div className="bg-[var(--bg-card)] border border-[var(--danger)]/30 rounded-lg p-4">
          <p className="text-sm text-[var(--danger)]">{error}</p>
        </div>
      )}
      {data && <AiMoneyView data={data} />}
    </div>
  );
}
