'use client';

/**
 * Вердикт по маршруту на сегодня: Идти / Осторожно / Не сегодня.
 *
 * Одно слово, одна причина и факты, из которых оно посчитано. Панель из
 * двенадцати метрик — не решение, а работа, переложенная на усталого
 * человека; но и слово без фактов под ним — уверенность без оснований.
 *
 * Отдельно оговорено поведение при отказе сети: блок НЕ исчезает. Соседний
 * SafetyWarnings при неудачном запросе возвращает null, и экран выглядит
 * так, будто предупреждений нет. Здесь наоборот — не дозвонились до сервера
 * значит «данных мало», и это сказано теми же словами, что и в правилах.
 */

import React, { useEffect, useState } from 'react';
import { CircleCheck, TriangleAlert, OctagonX } from 'lucide-react';
import type { VerdictStatus, RouteSignals, Verdict } from '@/lib/routes/go-verdict';

interface VerdictResponse {
  verdict: Verdict & { label: string };
  signals: RouteSignals;
}

const STYLES: Record<VerdictStatus, { color: string; ring: string; Icon: React.ElementType }> = {
  go: { color: 'var(--success)', ring: 'rgba(63,185,80,0.25)', Icon: CircleCheck },
  caution: { color: 'var(--warning)', ring: 'rgba(210,153,34,0.25)', Icon: TriangleAlert },
  no: { color: 'var(--danger)', ring: 'rgba(220,38,38,0.25)', Icon: OctagonX },
};

/** Ответ, которым блок живёт, пока сервер недоступен. */
const OFFLINE: VerdictResponse = {
  verdict: {
    status: 'caution',
    code: 'signals_unknown',
    reason: 'Нет связи с сервером — обстановку на сегодня узнать не удалось',
    unknown: ['предупреждения', 'вулканы на маршруте'],
    label: 'Осторожно',
  },
  signals: { alerts: null, volcanoes: null, inSeason: null, weather: null },
};

const ACC_RU: Record<string, string> = {
  green: 'зелёный', yellow: 'жёлтый', orange: 'оранжевый',
  red: 'красный', unassigned: 'код не присвоен',
};

/** Строка факта: что спросили и что ответили. `null` называется словами. */
function factLines(s: RouteSignals): Array<{ label: string; value: string; dim: boolean }> {
  const out: Array<{ label: string; value: string; dim: boolean }> = [];

  out.push(s.alerts === null
    ? { label: 'Предупреждения', value: 'не смогли узнать', dim: true }
    : s.alerts.length === 0
      ? { label: 'Предупреждения', value: 'действующих нет', dim: false }
      : { label: 'Предупреждения', value: s.alerts.map((a) => a.title).join(' · '), dim: false });

  out.push(s.volcanoes === null
    ? { label: 'Вулканы на маршруте', value: 'не смогли узнать', dim: true }
    : s.volcanoes.length === 0
      ? { label: 'Вулканы на маршруте', value: 'в 25 км нет', dim: false }
      : {
          label: 'Вулканы на маршруте',
          value: s.volcanoes.map((v) => `${v.name} — ${ACC_RU[v.acc] ?? v.acc}`).join(' · '),
          dim: false,
        });

  if (s.inSeason !== null) {
    out.push({ label: 'Сезон', value: s.inSeason ? 'маршрут в своём сезоне' : 'маршрут вне сезона', dim: false });
  }

  return out;
}

export default function RouteVerdict({ routeId }: { routeId: string }) {
  const [data, setData] = useState<VerdictResponse | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/routes/${routeId}/verdict`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('ответ не 200'))))
      .then((d: VerdictResponse) => { if (alive) setData(d); })
      // Молчание было бы худшим из ответов: экран выглядел бы спокойным.
      .catch(() => { if (alive) setData(OFFLINE); });
    return () => { alive = false; };
  }, [routeId]);

  if (!data) {
    return (
      <div className="ds-skeleton h-20 rounded-lg" aria-hidden="true" />
    );
  }

  const { verdict, signals } = data;
  const style = STYLES[verdict.status] ?? STYLES.caution;
  const { Icon } = style;
  const facts = factLines(signals);

  return (
    <section
      className="rounded-lg border p-4 bg-[var(--bg-card)]"
      style={{ borderColor: style.ring }}
      aria-label="Вердикт на сегодня"
    >
      <div className="flex items-start gap-3">
        <Icon className="w-6 h-6 shrink-0 mt-0.5" style={{ color: style.color }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="font-playfair text-2xl font-bold leading-none" style={{ color: style.color }}>
              {verdict.label}
            </p>
            <span className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
              на сегодня
            </span>
          </div>
          <p className="mt-1.5 text-sm text-[var(--text-primary)]">{verdict.reason}</p>

          <dl className="mt-3 space-y-1">
            {facts.map((f) => (
              <div key={f.label} className="flex flex-wrap gap-x-2 text-xs">
                <dt className="text-[var(--text-muted)]">{f.label}:</dt>
                <dd className={f.dim ? 'text-[var(--text-muted)] italic' : 'text-[var(--text-secondary)]'}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
            Это не официальный бюллетень: районных сводок по Камчатке нет.
            Вердикт складывается по правилам из того, что известно платформе,
            и решение остаётся за вами. Погода в него не входит — опасную
            погоду мы получаем предупреждением МЧС.
          </p>
        </div>
      </div>
    </section>
  );
}
