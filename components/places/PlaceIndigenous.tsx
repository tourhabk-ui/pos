'use client';

import { useState } from 'react';
import { Users, Star, Sprout, BookOpen, ChevronDown } from 'lucide-react';
import type { PlaceIndigenous as IndigenousData } from './types';

interface Props {
  indigenous: IndigenousData;
}

const PEOPLES_LABELS: Record<string, string> = {
  itelmen:  'Ительмены',
  koryak:   'Коряки',
  even:     'Эвены',
  chukchi:  'Чукчи',
  ainu:     'Айны',
  aleut:    'Алеуты',
};

export default function PlaceIndigenous({ indigenous }: Props) {
  const [expanded, setExpanded] = useState(false);
  const peopleLabels = indigenous.peoples
    .map(p => PEOPLES_LABELS[p] ?? p)
    .join(', ');

  return (
    <section className="max-w-3xl mx-auto px-4 mt-6">
      <div className="ds-card overflow-hidden border border-[var(--ocean)]/25">

        {/* Header (toggle) */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center gap-3 px-5 py-4 bg-[var(--ocean)]/6 text-left hover:bg-[var(--bg-hover)] transition-colors"
        >
          <div className="p-2 rounded-lg bg-[var(--ocean)]/12 text-[var(--ocean)] shrink-0">
            <Users className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Коренные народы
            </p>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {peopleLabels || 'Традиционная территория'}
            </p>
          </div>
          {indigenous.sacred && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-[var(--warning)]/12 text-[var(--warning)] shrink-0">
              <Star className="w-3 h-3" />
              Священное место
            </span>
          )}
          <ChevronDown
            className={`w-4 h-4 text-[var(--text-muted)] shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </button>

        {expanded && (
          <div className="px-5 py-4 space-y-4 border-t border-[var(--ocean)]/15">

            {indigenous.localName && (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  Традиционное название
                </p>
                <p className="text-base font-semibold text-[var(--text-primary)]"
                  style={{ fontFamily: 'var(--font-playfair)' }}>
                  {indigenous.localName}
                </p>
              </div>
            )}

            {indigenous.traditionalUse && (
              <div className="flex items-start gap-3">
                <Sprout className="w-4 h-4 text-[var(--success)] shrink-0 mt-0.5" />
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)] mb-1">
                    Традиционное природопользование
                  </p>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                    {indigenous.traditionalUse}
                  </p>
                </div>
              </div>
            )}

            {indigenous.sacred && !indigenous.respectNotes && (
              <div className="flex items-start gap-3 p-3 rounded-xl bg-[var(--warning)]/8 border border-[var(--warning)]/20">
                <Star className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
                <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                  Это место имеет культурное и духовное значение для коренных народов Камчатки.
                  Пожалуйста, ведите себя тихо и уважительно.
                </p>
              </div>
            )}

            {indigenous.respectNotes && (
              <div className="flex items-start gap-3 p-3 rounded-xl bg-[var(--warning)]/8 border border-[var(--warning)]/20">
                <BookOpen className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" />
                <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                  {indigenous.respectNotes}
                </p>
              </div>
            )}

            <p className="text-[11px] text-[var(--text-muted)] border-t border-[var(--border)] pt-3 leading-relaxed">
              Камчатка — исконная земля коренных малочисленных народов Севера. Их культура и
              традиционный уклад неотделимы от природы полуострова.
            </p>

          </div>
        )}
      </div>
    </section>
  );
}
