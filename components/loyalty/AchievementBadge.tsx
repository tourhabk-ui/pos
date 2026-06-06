'use client';

import { Award, Lock } from 'lucide-react';

interface AchievementBadgeProps {
  name: string;
  description: string;
  points: number;
  unlockedAt?: string | null;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function AchievementBadge({ name, description, points, unlockedAt }: AchievementBadgeProps) {
  const unlocked = Boolean(unlockedAt);

  return (
    <div
      className={`ds-card p-4 flex gap-3 items-start transition-colors ${
        unlocked ? 'border-[var(--success)]/30' : 'opacity-50'
      }`}
    >
      <div
        className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
          unlocked ? 'bg-[var(--success)]/15' : 'bg-[var(--bg-hover)]'
        }`}
      >
        {unlocked ? (
          <Award className="w-5 h-5 text-[var(--success)]" />
        ) : (
          <Lock className="w-4 h-4 text-[var(--text-muted)]" />
        )}
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-sm text-[var(--text-primary)] leading-snug">{name}</p>
        <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">{description}</p>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] font-semibold text-[var(--accent)]">+{points} баллов</span>
          {unlockedAt && (
            <span className="text-[10px] text-[var(--text-muted)]">{fmtDate(unlockedAt)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
