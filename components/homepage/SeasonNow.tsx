import Link from 'next/link';
import { Fish, ArrowRight } from 'lucide-react';
import { getActiveSpecies } from '@/lib/fish-species';
import { queryCatalogSummary } from '@/lib/search/tour-search';
import { fishingTourCount } from '@/lib/home/season-fishing';

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
 *
 * Аудит 24.09 (#126): карточки видов вели только в справочник /fish, и из
 * блока «идёт ход лосося» к турам на рыбалку пути не было. Под сеткой —
 * ссылка «Туры на рыбалку (N)» в витрину /catalog с фильтром рыбалки. N —
 * из сводки каталога (queryCatalogSummary: то же условие живого тура, что у
 * листинга), своего счёта нет. Туров на рыбалку нет — нет и ссылки (в пустую
 * витрину не зовём). Сводка не прочиталась — ссылка без числа, а отказ в
 * логе (§4.0): число, которого мы не знаем, не пишем.
 */
async function fishingCount(): Promise<number | null> {
  try {
    return fishingTourCount(await queryCatalogSummary());
  } catch (err) {
    const e = err as { code?: string; message?: string } | undefined;
    console.error('[home] SeasonNow: сводка каталога не прочитана', { sqlstate: e?.code, message: e?.message });
    return null;
  }
}

export async function SeasonNow() {
  const month = Number(
    new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Kamchatka', month: 'numeric' }).format(new Date()),
  );
  const active = getActiveSpecies(month);

  if (active.length === 0) return null;
  const fishing = await fishingCount();

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
              <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-snug">{species.season}</p>
            </div>
          </Link>
        ))}
      </div>

      {fishing !== 0 && (
        <Link
          href="/catalog?activity_type=fishing"
          className="mt-5 inline-flex items-center min-h-[44px] gap-2 text-sm font-semibold text-[var(--accent)] hover:underline"
        >
          <span className="lining-nums">Туры на рыбалку{fishing != null ? ` (${fishing})` : ''}</span>
          <ArrowRight size={16} aria-hidden />
        </Link>
      )}
    </section>
  );
}
