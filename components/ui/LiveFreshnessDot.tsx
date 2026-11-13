'use client';

/**
 * Точка свежести на иконке «Радар» (12.11, «Радар: точка мягко пульсирует»).
 *
 * Пульс — только у свежих данных: он и значит «живое». У устаревших точка
 * жёлтая и стоит, у «нет данных» точки нет вовсе — только контур (§4.0:
 * пульс над незнанием выдал бы его за живую обстановку). При «уменьшить
 * движение» пульса нет, остаётся цвет.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { freshnessDot } from '@/lib/home/data-freshness';
import type { FreshnessState } from '@/lib/home/data-freshness';

export function LiveFreshnessDot({ state, className }: { state: FreshnessState; className?: string }) {
  const reduce = useReducedMotion() === true;
  const color = freshnessDot(state);
  if (!color) {
    return (
      <i
        className={className}
        data-freshness={state}
        style={{ border: '1px solid var(--text-muted)', background: 'var(--bg-card)' }}
      />
    );
  }
  const pulse = state === 'fresh' && !reduce;
  return (
    <i className={className} data-freshness={state} data-pulse={pulse ? 'on' : 'off'} style={{ background: color }}>
      {pulse && (
        <motion.i
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color, display: 'block' }}
          initial={{ scale: 1, opacity: 0.55 }}
          animate={{ scale: 2.4, opacity: 0 }}
          transition={{ duration: 2.2, ease: 'easeOut', repeat: Infinity, repeatDelay: 1.2 }}
        />
      )}
    </i>
  );
}
