/**
 * components/routes/ReliefChart.tsx
 *
 * График высот всего маршрута для карточки /routes/[id].
 *
 * До 03.10 на карточке были только четыре числа (набор, сброс, мин, макс), а
 * сам профиль сервер уже считал и отдавал полем `relief` — им пользовался
 * только экран «На маршруте» (срез «впереди»). У Organic Maps и Gaia профиль
 * стоит на карточке, и решение «осилю ли я этот подъём» человек принимает
 * дома, а не на тропе.
 *
 * Правило то же, что у среза в поле: рисуем только `reliable` профиль. Высот в
 * данных нет — графика нет вовсе, а не ровная линия из ничего. Высоты из
 * модели рельефа подписаны словами: у модели нет ям, троп и свежих осыпей.
 */

export interface ReliefPointView { dM: number; zM: number }

interface Props {
  points: ReliefPointView[];
  minM: number | null;
  maxM: number | null;
  /** Откуда высоты: null — из самого трека, строка — дозаполнены моделью. */
  source: string | null;
}

const W = 320;
const H = 112;
const TOP = 10;
const BOTTOM = 102;

export default function ReliefChart({ points, minM, maxM, source }: Props) {
  if (points.length < 2) return null;
  const maxD = points[points.length - 1].dM || 1;
  const zs = points.map((p) => p.zM);
  const lo = Math.min(...zs);
  const hi = Math.max(...zs);
  const range = Math.max(1, hi - lo);
  const xy = points.map((p) => ({
    x: (p.dM / maxD) * W,
    y: BOTTOM - ((p.zM - lo) / range) * (BOTTOM - TOP),
  }));
  const line = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const km = maxD / 1000;
  const top = Math.round(maxM ?? hi);
  const bottom = Math.round(minM ?? lo);

  return (
    <figure className="m-0">
      <figcaption className="flex items-baseline justify-between mb-1.5 text-[11px] text-[var(--text-muted)]">
        <span>
          Профиль высот
          {source && <span> · по модели рельефа</span>}
        </span>
        <span className="tabular-nums">{km < 10 ? km.toFixed(1) : Math.round(km)} км</span>
      </figcaption>
      <div className="relative w-full h-28 rounded-lg overflow-hidden border border-[var(--border)]"
        style={{ background: 'color-mix(in srgb, var(--success) 6%, var(--bg-card))' }}>
        <svg className="w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
          role="img" aria-label={`Профиль высот: от ${bottom} до ${top} м на ${km.toFixed(1)} км`}>
          <polyline points={`0,${H} ${line} ${W},${H}`}
            fill="color-mix(in srgb, var(--success) 14%, transparent)" stroke="none" />
          <polyline points={line} fill="none" stroke="var(--success)" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Подписи — HTML поверх, а не текст в SVG: preserveAspectRatio="none"
            растягивает буквы вместе с графиком. */}
        <span className="absolute left-1.5 top-1 text-[10px] tabular-nums text-[var(--text-secondary)]">{top} м</span>
        <span className="absolute left-1.5 bottom-1 text-[10px] tabular-nums text-[var(--text-secondary)]">{bottom} м</span>
      </div>
    </figure>
  );
}
