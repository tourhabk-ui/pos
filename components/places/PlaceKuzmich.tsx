'use client';

import { MessageCircle } from 'lucide-react';
import type { PlaceAdvisory, AdvisoryTone } from '@/lib/kuzmich/place-advisory';

interface Props {
  placeId: string;
  placeName: string;
  kuzmichReview: string | null;
  /** Проактивный совет «сегодня здесь» — детерминированный, из живых данных. */
  advisory?: PlaceAdvisory | null;
}

// Тон → семантический цвет (§7): зелёный/жёлтый/лава/красный. Не украшение —
// цвет несёт состояние.
const TONE_COLOR: Record<AdvisoryTone, string> = {
  ok: 'var(--success)', caution: 'var(--warning)', danger: 'var(--danger)', unknown: 'var(--text-muted)',
};

export default function PlaceKuzmich({ placeId, placeName, kuzmichReview, advisory }: Props) {
  const chatUrl = `/chat?context=place&id=${placeId}&name=${encodeURIComponent(placeName)}`;

  return (
    <section className="max-w-3xl mx-auto px-4">
      {/* Проактивный совет на сегодня — над вечным «о месте». Живёт, только
          если есть данные (в т.ч. честное «данных нет»). */}
      {advisory && (
        <div className="ds-card p-4 mb-3" style={{ borderLeft: `4px solid ${TONE_COLOR[advisory.tone]}` }}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: TONE_COLOR[advisory.tone] }} aria-hidden />
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              Кузьмич — сегодня здесь: {advisory.headline}
            </p>
          </div>
          <ul className="space-y-1">
            {advisory.lines.map((l, i) => (
              <li key={i} className="text-sm text-[var(--text-secondary)] leading-relaxed">{l}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="ds-card p-5 border-l-4 border-[var(--ocean)]">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-[var(--ocean)] flex items-center justify-center flex-shrink-0 text-white text-sm font-bold">
            К
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[var(--text-primary)] mb-1">Кузьмич о месте</p>
            {kuzmichReview ? (
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{kuzmichReview}</p>
            ) : (
              <p className="text-sm text-[var(--text-muted)] italic">
                Кузьмич знает Камчатку как никто. Спроси его про безопасность, лучший сезон, как добраться и что взять с собой.
              </p>
            )}
            <a
              href={chatUrl}
              className="inline-flex items-center gap-2 mt-3 text-sm font-medium text-[var(--ocean)] hover:text-[var(--accent)] transition-colors"
            >
              <MessageCircle className="w-4 h-4" />
              Спросить Кузьмича про {placeName}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
