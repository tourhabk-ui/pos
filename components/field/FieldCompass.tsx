'use client';

/**
 * Полевой компас — главный прибор экрана (макеты FCN, этапы 3/6).
 *
 * Это не декоративный кружок, а шкала, по которой человек в тумане берёт
 * направление: засечки через 5°, оцифровка через 30°, крупные стороны
 * света и стрелка, показывающая азимут НА СЛЕДУЮЩУЮ ТОЧКУ, а не на север.
 *
 * ── Инварианты честности (перенесены с прежней реализации, не ослаблены) ──
 *
 * Кольцо сторон света поворачивается ТОЛЬКО с подтверждённым азимутом.
 * Раньше guard стоял лишь на стрелке, и на скрине владельца 09.08 вышло
 * худшее: стрелка погашена и смотрит вверх, а кольцо развёрнуто на 270° —
 * «север справа». Прибор из одного мёртвого датчика делал два
 * противоречащих утверждения.
 *
 * Стрелка при неподтверждённом компасе гасится и не крутится: движущаяся
 * стрелка читается как рабочая.
 *
 * Прибор непрозрачный: стекло — для контекста, приборы — для действия.
 */

import type { CompassState } from '@/lib/on-route/fix-quality';
import { formatBearing } from '@/lib/on-route/bearing';

export interface FieldCompassProps {
  /** Курс устройства (куда смотрит телефон), 0–360. */
  heading: number;
  state: CompassState;
  /** Истинный азимут на следующую точку; null — цели нет. */
  targetBearing: number | null;
  size?: number;
}

const CARDINALS = [
  { label: 'С', angle: 0 },
  { label: 'В', angle: 90 },
  { label: 'Ю', angle: 180 },
  { label: 'З', angle: 270 },
];

/** Оцифровка через 30°, кроме сторон света — там буквы. */
const DEGREE_LABELS = [30, 60, 120, 150, 210, 240, 300, 330];

export function FieldCompass({ heading, state, targetBearing, size = 300 }: FieldCompassProps) {
  const trusted = state === 'ok';
  const c = size / 2;
  const rOuter = c - 6;
  const rTickOuter = c - 26;

  // Кольцо (засечки, цифры, буквы) крутится вместе с землёй — только когда
  // азимуту можно верить. Иначе стоит в нуле: север сверху, как на карте.
  const ringRotation = trusted ? -heading : 0;
  // Стрелка смотрит на цель ОТНОСИТЕЛЬНО текущего курса: так она указывает
  // в реальную сторону, если держать телефон перед собой.
  const needleAngle = targetBearing === null ? null : (trusted ? targetBearing - heading : targetBearing);

  const ticks: React.ReactElement[] = [];
  for (let a = 0; a < 360; a += 5) {
    const major = a % 30 === 0;
    const len = major ? 14 : 7;
    const rad = (a * Math.PI) / 180;
    const x1 = c + (rTickOuter - len) * Math.sin(rad);
    const y1 = c - (rTickOuter - len) * Math.cos(rad);
    const x2 = c + rTickOuter * Math.sin(rad);
    const y2 = c - rTickOuter * Math.cos(rad);
    ticks.push(
      <line key={a} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={a === 0 && trusted ? 'var(--success)' : 'rgba(255,255,255,0.55)'}
        strokeWidth={major ? 2.5 : 1.4}
        opacity={trusted ? 1 : 0.4} />,
    );
  }

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {/* Корпус прибора: непрозрачный, с фаской по краю */}
        <circle cx={c} cy={c} r={rOuter} fill="#12181f" stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
        <circle cx={c} cy={c} r={rOuter - 10} fill="#0c1116" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />

        {/* Шкала — вращается только с подтверждённым азимутом */}
        <g transform={`rotate(${ringRotation} ${c} ${c})`}
          style={{ transition: 'transform 0.3s ease' }}>
          {ticks}
          {DEGREE_LABELS.map(a => {
            const rad = (a * Math.PI) / 180;
            const rr = rTickOuter - 30;
            return (
              <text key={a}
                x={c + rr * Math.sin(rad)} y={c - rr * Math.cos(rad)}
                textAnchor="middle" dominantBaseline="central"
                fill="rgba(255,255,255,0.6)" fontSize={size * 0.052} fontWeight={500}
                opacity={trusted ? 1 : 0.4}
                transform={`rotate(${-ringRotation} ${c + rr * Math.sin(rad)} ${c - rr * Math.cos(rad)})`}>
                {a}
              </text>
            );
          })}
          {CARDINALS.map(({ label, angle }) => {
            const rad = (angle * Math.PI) / 180;
            const rr = rTickOuter - 30;
            const x = c + rr * Math.sin(rad);
            const y = c - rr * Math.cos(rad);
            return (
              <text key={label} x={x} y={y}
                textAnchor="middle" dominantBaseline="central"
                fill={label === 'С' && trusted ? 'var(--success)' : '#F0F6FC'}
                fontSize={size * 0.105} fontWeight={700}
                opacity={trusted ? 1 : 0.45}
                transform={`rotate(${-ringRotation} ${x} ${y})`}>
                {label}
              </text>
            );
          })}
        </g>

        {/* Метка курса — неподвижный треугольник сверху: куда смотрит телефон */}
        <polygon points={`${c},${18} ${c - 8},${32} ${c + 8},${32}`}
          fill={trusted ? 'var(--success)' : 'rgba(255,255,255,0.35)'} />

        {/* Стрелка на следующую точку */}
        {needleAngle !== null && (
          <g transform={`rotate(${trusted ? needleAngle : 0} ${c} ${c})`}
            style={{ transition: 'transform 0.3s ease' }}
            opacity={trusted ? 1 : 0.35}>
            <line x1={c} y1={c} x2={c} y2={c - (rTickOuter - 48)}
              stroke={trusted ? 'var(--success)' : 'var(--text-muted)'} strokeWidth="9" strokeLinecap="round" />
            <polygon
              points={`${c},${c - (rTickOuter - 28)} ${c - 17},${c - (rTickOuter - 60)} ${c + 17},${c - (rTickOuter - 60)}`}
              fill={trusted ? 'var(--success)' : 'var(--text-muted)'} />
          </g>
        )}

        {/* Ось прибора */}
        <circle cx={c} cy={c} r={size * 0.055} fill="#1b232b" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
        <circle cx={c} cy={c} r={size * 0.022} fill="#0a0e12" />
      </svg>

      {/* Азимут словами под осью — то же число, что показывает стрелка */}
      {targetBearing !== null && (
        <div className="absolute inset-x-0 flex flex-col items-center"
          style={{ top: '58%' }}>
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>На точку:</span>
          <span className="text-2xl font-bold tabular-nums"
            style={{ color: trusted ? 'var(--success)' : 'var(--text-muted)' }}>
            {formatBearing(targetBearing)}
          </span>
        </div>
      )}
    </div>
  );
}
