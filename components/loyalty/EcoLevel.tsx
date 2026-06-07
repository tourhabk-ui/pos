'use client';

interface EcoLevelProps {
  level: number;
  totalPoints: number;
}

const LEVELS = [
  { level: 1, name: 'Новичок',    color: '#6B7280', min: 0,    max: 100  },
  { level: 2, name: 'Бронза',     color: '#92400E', min: 100,  max: 300  },
  { level: 3, name: 'Серебро',    color: '#6B7280', min: 300,  max: 700  },
  { level: 4, name: 'Золото',     color: '#D29922', min: 700,  max: 1500 },
  { level: 5, name: 'Платина',    color: '#2568B0', min: 1500, max: 1500 },
];

export function EcoLevel({ level, totalPoints }: EcoLevelProps) {
  const current = LEVELS.find(l => l.level === level) ?? LEVELS[0];
  const next = LEVELS.find(l => l.level === level + 1);

  const progress = next
    ? Math.min(100, Math.round(((totalPoints - current.min) / (next.min - current.min)) * 100))
    : 100;

  return (
    <div className="ds-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-1">
            Eco-уровень
          </p>
          <p
            className="text-xl font-bold"
            style={{ color: current.color }}
          >
            {current.name}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-[var(--text-primary)]">
            {totalPoints.toLocaleString('ru-RU')}
          </p>
          <p className="text-xs text-[var(--text-muted)]">баллов</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden mb-2">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${progress}%`, backgroundColor: current.color }}
        />
      </div>

      <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>{current.name}</span>
        {next ? (
          <span>{next.name} — ещё {(next.min - totalPoints).toLocaleString('ru-RU')} баллов</span>
        ) : (
          <span>Максимальный уровень</span>
        )}
      </div>
    </div>
  );
}
