import Link from 'next/link';
import { PLAN_PRESETS, type PlanPreset } from '@/lib/plans/presets';
import { circularNext } from '@/lib/seo/circular-links';

/** Сколько соседних планов показывать под планом. */
export const OTHER_PLANS = 6;

/**
 * «Другие готовые планы» — следующие по кругу, а не первые шесть (14.10).
 *
 * Прежде блок брал `PLAN_PRESETS.slice(0, 6)`: первые шесть планов получали
 * ссылку с каждой страницы раздела, а на планы с седьмого и дальше не вёл ни
 * один другой план. Перепись sitemap (прогон 10): 9 планов с единственной
 * входящей ссылкой — с хаба /plans. Следующие по кругу дают каждому ровно
 * OTHER_PLANS входящих (lib/seo/circular-links).
 */
export function OtherPlans({ current, presets = PLAN_PRESETS }: {
  current: string;
  presets?: readonly PlanPreset[];
}) {
  const others = circularNext(presets, (p) => p.slug === current, OTHER_PLANS);
  if (others.length === 0) return null;
  return (
    <section className="space-y-2" aria-labelledby="other-plans">
      <h2 id="other-plans" className="ds-h2">Другие готовые планы</h2>
      <div className="flex flex-wrap gap-2">
        {others.map((p) => (
          <Link key={p.slug} href={`/plans/${p.slug}`}
            className="text-sm px-3 py-1.5 rounded-full"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--ocean)' }}>
            {p.title}
          </Link>
        ))}
      </div>
    </section>
  );
}
