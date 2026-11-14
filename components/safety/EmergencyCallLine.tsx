import { Phone } from 'lucide-react';
import { EMERGENCY_PRIMARY, telHref } from '@/lib/safety/emergency-numbers';

/**
 * Строка экстренного вызова — номером из единого источника
 * (lib/safety/emergency-numbers), а не словами модели.
 *
 * Заведена 14.11 для «Анализатора безопасности» (/tools/safety): блок «ЧС» там
 * пишет модель, и номера 112 в результате могло не быть вовсе. Номер, по
 * которому звонят в беде, обязан стоять на экране при любом ответе модели и
 * при её молчании. Чистая константа: работает и без сети.
 */
export function EmergencyCallLine() {
  const n = EMERGENCY_PRIMARY;
  return (
    <a
      href={telHref(n.phone)}
      className="flex items-center gap-3 min-h-[44px] bg-[var(--bg-card)] border border-[var(--danger)]/30 rounded-lg px-4 py-3 transition-colors hover:bg-[var(--bg-hover)]"
    >
      <Phone size={16} className="text-[var(--danger)] flex-shrink-0" aria-hidden="true" />
      <span>
        <span className="block text-sm font-bold text-[var(--text-primary)]">
          Экстренный вызов — {n.phone}
        </span>
        <span className="block text-xs text-[var(--text-secondary)]">
          {n.name}.{n.hint ? ` ${n.hint}` : ''}
        </span>
      </span>
    </a>
  );
}
