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
  /**
   * Откуда взят курс: магнитный датчик или курс по движению GPS. Родословная
   * значения — тот же закон, что у линий на карте (§12): прибор называет
   * источник словами, а не выдаёт один за другой.
   */
  headingSource?: 'sensor' | 'motion' | null;
}

const CARDINALS = [
  { label: 'С', angle: 0 },
  { label: 'В', angle: 90 },
  { label: 'Ю', angle: 180 },
  { label: 'З', angle: 270 },
];

/** Оцифровка через 30°, кроме сторон света — там буквы. */
const DEGREE_LABELS = [30, 60, 120, 150, 210, 240, 300, 330];

export function FieldCompass({ heading, state, targetBearing, size = 300, headingSource }: FieldCompassProps) {
  const trusted = state === 'ok';
  const c = size / 2;
  /**
   * Всё внутри считается ДОЛЕЙ размера, а не пикселями.
   *
   * Компонент писался под size=300, а на полевом экране стоит size=110
   * (владелец 01.09: «компас чуть-чуть увеличить, не видно надписей и
   * стрелка теряется»). Фиксированные константы — отступ подписей 30,
   * метка курса на y=18, толщина стрелки 9, наконечник +-17 — на 110
   * пикселях занимали втрое большую долю прибора: цифры уезжали к оси,
   * стрелка накрывала шкалу собой. Прибор был не мелким, а
   * непропорциональным, и «увеличить» одним числом это не лечило.
   *
   * k — коэффициент к исходному эталону 300.
   */
  const k = size / 300;
  const rOuter = c - 6 * k;
  const rTickOuter = c - 26 * k;

  // Кольцо (засечки, цифры, буквы) крутится вместе с землёй — только когда
  // азимуту можно верить. Иначе стоит в нуле: север сверху, как на карте.
  const ringRotation = trusted ? -heading : 0;
  // Стрелка смотрит на цель ОТНОСИТЕЛЬНО текущего курса — и живёт ТОЛЬКО
  // при подтверждённом азимуте. Раньше неподтверждённая рисовалась серой в
  // абсолютном угле: та же картинка означала другое, а прозрачность на
  // солнце не читается — человек в тумане шёл за стрелкой, которая не
  // значила «иди сюда». Число внизу говорит азимут без стрелки: число не
  // умеет притворяться живым.
  const needleAngle = trusted && targetBearing !== null ? targetBearing - heading : null;

  const ticks: React.ReactElement[] = [];
  for (let a = 0; a < 360; a += 5) {
    const major = a % 30 === 0;
    const len = (major ? 14 : 7) * k;
    const rad = (a * Math.PI) / 180;
    const x1 = c + (rTickOuter - len) * Math.sin(rad);
    const y1 = c - (rTickOuter - len) * Math.cos(rad);
    const x2 = c + rTickOuter * Math.sin(rad);
    const y2 = c - rTickOuter * Math.cos(rad);
    ticks.push(
      <line key={a} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={a === 0 && trusted ? 'var(--success)' : 'rgba(255,255,255,0.55)'}
        strokeWidth={(major ? 2.5 : 1.4) * k}
        opacity={trusted ? 1 : 0.4} />,
    );
  }

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {/* Корпус прибора: непрозрачный, с фаской по краю */}
        <circle cx={c} cy={c} r={rOuter} fill="#12181f" stroke="rgba(255,255,255,0.14)" strokeWidth={2 * k} />
        <circle cx={c} cy={c} r={rOuter - 10 * k} fill="#0c1116" stroke="rgba(255,255,255,0.07)" strokeWidth={1 * k} />

        {/* Шкала — вращается только с подтверждённым азимутом */}
        <g transform={`rotate(${ringRotation} ${c} ${c})`}
          style={{ transition: 'transform 0.3s ease' }}>
          {ticks}
          {DEGREE_LABELS.map(a => {
            const rad = (a * Math.PI) / 180;
            const rr = rTickOuter - 30 * k;
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
            const rr = rTickOuter - 30 * k;
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
        <polygon points={`${c},${10 * k} ${c - 8 * k},${26 * k} ${c + 8 * k},${26 * k}`}
          fill={trusted ? 'var(--success)' : 'rgba(255,255,255,0.35)'} />

        {/* Стрелка на следующую точку — только живая */}
        {needleAngle !== null && (
          <g transform={`rotate(${needleAngle} ${c} ${c})`}
            style={{ transition: 'transform 0.3s ease' }}>
            {/* Тёмная подложка под стрелкой: зелёное по зелёной шкале
                сливалось, и стрелка «терялась» — тот же приём, что у линии
                маршрута на карте (casing под треком). */}
            <line x1={c} y1={c} x2={c} y2={c - (rTickOuter - 30 * k)}
              stroke="#0a0e12" strokeWidth={10 * k} strokeLinecap="round" opacity={0.85} />
            <line x1={c} y1={c} x2={c} y2={c - (rTickOuter - 30 * k)}
              stroke="var(--success)" strokeWidth={6 * k} strokeLinecap="round" />
            <polygon
              points={`${c},${c - (rTickOuter - 12 * k)} ${c - 13 * k},${c - (rTickOuter - 42 * k)} ${c + 13 * k},${c - (rTickOuter - 42 * k)}`}
              fill="var(--success)" stroke="#0a0e12" strokeWidth={1.5 * k} />
          </g>
        )}

        {/* Ось прибора */}
        <circle cx={c} cy={c} r={size * 0.055} fill="#1b232b" stroke="rgba(255,255,255,0.18)" strokeWidth={1.5 * k} />
        <circle cx={c} cy={c} r={size * 0.022} fill="#0a0e12" />
      </svg>

      {/* Азимут словами под осью — то же число, что показывает стрелка.
          Без стрелки оно остаётся единственным честным ответом прибора. */}
      {targetBearing !== null && (
        <div className="absolute inset-x-0 flex flex-col items-center"
          style={{ top: '54%' }}>
          {/* Плашка под числом. Раньше подписи лежали прямо на засечках и на
              стрелке — на 110 пикселях это каша, а число азимута и есть
              главный ответ прибора, когда стрелки нет вовсе (правило 21.08).
              Непрозрачная, не стеклянная: §2 — критичные приборы не блюрятся. */}
          <div className="flex flex-col items-center rounded-lg"
            style={{
              background: 'rgba(10,14,18,0.88)',
              padding: `${Math.max(2, 4 * k)}px ${Math.max(6, 10 * k)}px`,
            }}>
            <span style={{
              color: 'rgba(255,255,255,0.55)',
              fontSize: Math.max(9, 11 * k),
              lineHeight: 1.1,
            }}>На точку:</span>
            <span className="font-bold tabular-nums"
              style={{
                color: trusted ? 'var(--success)' : 'var(--text-muted)',
                // Пол в 17px: ниже этого азимут перестаёт читаться на ходу,
                // а он — единственный честный ответ без стрелки.
                fontSize: Math.max(17, 26 * k),
                lineHeight: 1.15,
              }}>
              {formatBearing(targetBearing)}
            </span>
          </div>
          {/* Родословная курса — словами, как у линий на карте. Вынесена ПОД
              плашку и не наезжает на шкалу. */}
          <span className="text-center leading-tight"
            style={{
              color: 'rgba(255,255,255,0.5)',
              fontSize: Math.max(8, 10 * k),
              marginTop: Math.max(2, 3 * k),
              paddingLeft: 4, paddingRight: 4,
            }}>
            {trusted
              ? (headingSource === 'motion' ? 'курс — по движению GPS' : 'азимут — магнитный датчик')
              : 'стрелка скрыта: азимут не подтверждён'}
          </span>
        </div>
      )}
    </div>
  );
}
