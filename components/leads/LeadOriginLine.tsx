/**
 * Строка «Откуда» у заявки — одна на админский список, список и карточку лида
 * у оператора (слово владельца 08.11: «нужно писать, откуда лиды — человек
 * или ИИ и через какой инструмент»). Подпись считает сервер
 * (lib/leads/origin, поле `origin` в ответе /api/leads); здесь только вид:
 * значок того, кто отправил, и подпись словами. Нет подписи — нет строки:
 * экран не придумывает происхождение сам.
 */
import { Bot, CircleHelp, User } from 'lucide-react';

export interface LeadOriginView {
  actor: 'human' | 'agent' | null;
  label: string;
}

export function LeadOriginLine({ origin, className = '' }: { origin?: LeadOriginView | null; className?: string }) {
  if (!origin?.label) return null;
  const Icon = origin.actor === 'agent' ? Bot : origin.actor === 'human' ? User : CircleHelp;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} data-lead-actor={origin.actor ?? 'unknown'}>
      <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span>Откуда: {origin.label}</span>
    </span>
  );
}
