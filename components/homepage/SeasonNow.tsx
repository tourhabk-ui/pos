import Link from 'next/link';
import { Fish } from 'lucide-react';
import { getActiveSpecies } from '@/lib/fish-species';

/**
 * «Сейчас на Камчатке» — event-driven travel, пилот на реальных данных
 * (issue #1421). Единственный источник дат — seasonMonths в lib/fish-species,
 * тот же справочник, что кормит /fish и блок «Когда какая рыба клюёт?» на
 * карточке тура. Календаря фестивалей здесь нет: у него нет источника дат,
 * а придуманная дата события хуже отсутствующей (CLAUDE.md §4.0).
 *
 * Месяц — по камчатскому времени: сервер может стоять в любом часовом поясе,
 * а «сейчас» для этого блока должно значить «сейчас на Камчатке».
 *
 * Межсезонье (нет активных видов) — законный результат: блок просто не
 * рендерится, а не показывает пустую рамку или последний известный сезон.
 */
export function SeasonNow() {
  const month = Number(
    new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Kamchatka', month: 'numeric' }).format(new Date()),
  );
  const active = getActiveSpecies(month);

  if (active.length === 0) return null;

  return (
    <section className="px-4 py-10 max-w-6xl mx-auto">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--accent)] mb-2">
          Сейчас на Камчатке
        </p>
        <h2 className="font-playfair text-2xl md:text-3xl font-bold text-[var(--text-primary)]">
          Идёт ход {active.length === 1 ? active[0].name.toLowerCase() : 'лосося'}
        </h2>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {active.map(species => (
          <Link
            key={species.id}
            href={`/fish/${species.id}`}
            className="ds-card flex items-center gap-3 py-4 px-4 hover:border-[var(--accent)] transition-all group"
          >
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-transform group-hover:scale-110"
              style={{ background: `color-mix(in srgb, ${species.color} 12%, var(--bg-card))`, color: species.color }}
            >
              <Fish size={18} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--text-primary)] leading-snug">{species.name}</p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-snug">{species.season}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
