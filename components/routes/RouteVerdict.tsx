'use client';

/**
 * Вердикт по маршруту на сегодня: Идти / Осторожно / Не сегодня.
 *
 * Одно слово, одна причина и факты, из которых оно посчитано. Панель из
 * двенадцати метрик — не решение, а работа, переложенная на усталого
 * человека; но и слово без фактов под ним — уверенность без оснований.
 *
 * Вес блока задаётся не здесь, а в lib/routes/verdict-presentation: правило
 * одно — вес растёт с опасностью. Спокойный день выглядит строкой, запрет —
 * карточкой с полосой. Три блока одинакового веса приучили бы не отличать
 * запрет от разрешения.
 *
 * Отдельно оговорено поведение при отказе сети: блок НЕ исчезает. Соседний
 * SafetyWarnings при неудачном запросе возвращает null, и экран выглядит
 * так, будто предупреждений нет. Здесь наоборот — не дозвонились до сервера
 * значит «данных мало», и это сказано теми же словами, что и в правилах.
 */

import React, { useEffect, useState } from 'react';
import { CircleCheck, TriangleAlert, OctagonX } from 'lucide-react';
import type { VerdictStatus, RouteSignals, Verdict } from '@/lib/routes/go-verdict';
import { verdictLook } from '@/lib/routes/verdict-presentation';
import { verdictFactLines, VERDICT_DISCLAIMER_RU } from '@/lib/routes/verdict-facts';

export interface VerdictResponse {
  verdict: Verdict & { label: string };
  signals: RouteSignals;
}

const ICONS: Record<VerdictStatus, React.ElementType> = {
  go: CircleCheck,
  caution: TriangleAlert,
  no: OctagonX,
};

/** Ответ, которым блок живёт, пока сервер недоступен. */
const OFFLINE: VerdictResponse = {
  verdict: {
    status: 'caution',
    code: 'signals_unknown',
    reason: 'Нет связи с сервером — обстановку на сегодня узнать не удалось',
    unknown: ['предупреждения', 'вулканы на маршруте', 'закрытые точки'],
    label: 'Осторожно',
  },
  signals: { alerts: null, volcanoes: null, inSeason: null, weather: null, closures: null },
};

/**
 * Один запрос на страницу.
 *
 * Вердикт нужен и блоку, и строке под кнопкой навигации. Второй fetch дал бы
 * второй источник правды: два ответа могли бы разойтись во времени, и на
 * одном экране оказались бы разные вердикты об одном дне.
 */
export function useRouteVerdict(routeId: string): VerdictResponse | null {
  const [data, setData] = useState<VerdictResponse | null>(null);

  useEffect(() => {
    // Пустой id — вердикт уже передан страницей. Без этой проверки уходил
    // запрос /api/routes//verdict и получал 400 на каждой карточке (аудит
    // UI/UX 29.09).
    if (!routeId) return;
    let alive = true;
    fetch(`/api/routes/${encodeURIComponent(routeId)}/verdict`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('ответ не 200'))))
      .then((d: VerdictResponse) => { if (alive) setData(d); })
      // Молчание было бы худшим из ответов: экран выглядел бы спокойным.
      .catch(() => { if (alive) setData(OFFLINE); });
    return () => { alive = false; };
  }, [routeId]);

  return data;
}

// Слова фактов — lib/routes/verdict-facts: те же, что в ответе Кузьмича и MCP
// о маршруте (#3302). Своей копии строк здесь быть не должно.
function Facts({ signals }: { signals: RouteSignals }) {
  return (
    <dl className="mt-3 space-y-1">
      {verdictFactLines(signals).map((f) => (
        <div key={f.label} className="flex flex-wrap gap-x-2 text-xs">
          <dt className="text-[var(--text-muted)]">{f.label}:</dt>
          <dd className={f.dim ? 'text-[var(--text-muted)] italic' : 'text-[var(--text-secondary)]'}>
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function RouteVerdict({ routeId, data: given }: { routeId: string; data?: VerdictResponse | null }) {
  // Хук зовётся всегда (правила хуков), но при переданных данных его ответ
  // не используется: страница уже сходила за вердиктом один раз.
  const fetched = useRouteVerdict(given === undefined ? routeId : '');
  const data = given !== undefined ? given : fetched;

  if (!data) return <div className="ds-skeleton h-16 rounded-lg" aria-hidden="true" />;

  const { verdict, signals } = data;
  const look = verdictLook(verdict.status);
  const Icon = ICONS[verdict.status] ?? TriangleAlert;

  // ── Спокойный день: строка, а не карточка ────────────────────────────────
  // Читается за секунду и не занимает экран. Факты доступны, но убраны:
  // «Идти» не должно предъявлять список проверенного.
  if (look.prominence === 0) {
    return (
      <section aria-label="Вердикт на сегодня" className="py-1">
        <details className="group">
          <summary className="flex items-center gap-2.5 cursor-pointer list-none">
            <Icon className="w-4 h-4 shrink-0" style={{ color: look.color }} aria-hidden="true" />
            <span className={look.titleClass} style={{ color: look.color }}>{verdict.label}</span>
            <span className="text-sm text-[var(--text-secondary)] min-w-0 truncate">{verdict.reason}</span>
            <span className="ml-auto text-[10px] uppercase tracking-widest text-[var(--text-muted)] group-open:hidden">
              Что проверено
            </span>
          </summary>
          <Facts signals={signals} />
        </details>
      </section>
    );
  }

  // ── Есть о чём подумать: карточка; у запрета — ещё и полоса ──────────────
  return (
    <section
      className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4"
      style={look.bar ? { borderLeft: `3px solid ${look.color}` } : undefined}
      aria-label="Вердикт на сегодня"
    >
      <div className="flex items-start gap-3">
        <Icon
          className={look.prominence === 2 ? 'w-6 h-6 shrink-0 mt-0.5' : 'w-5 h-5 shrink-0 mt-0.5'}
          style={{ color: look.color }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className={`${look.titleClass} leading-none`} style={{ color: look.color }}>
              {verdict.label}
            </p>
            <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
              на сегодня
            </span>
          </div>
          <p className="mt-1.5 text-sm text-[var(--text-primary)]">{verdict.reason}</p>

          {look.factsOpen && <Facts signals={signals} />}

          {look.disclaimer && (
            <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
              {VERDICT_DISCLAIMER_RU}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
