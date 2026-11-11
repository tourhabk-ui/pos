/**
 * Строка «Откуда» у заявки — одна на админский список, список и карточку лида
 * у оператора (слово владельца 08.11: «нужно писать, откуда лиды — человек
 * или ИИ и через какой инструмент»). Подпись считает сервер
 * (lib/leads/origin, поле `origin` в ответе /api/leads); здесь только вид:
 * значок того, кто отправил, и подпись словами. Нет подписи — нет строки:
 * экран не придумывает происхождение сам.
 */
import { Bot, CircleHelp, ShieldAlert, ShieldCheck, User } from 'lucide-react';
import { CONSENT_WORDS } from '@/lib/leads/origin';

export interface LeadOriginView {
  actor: 'human' | 'agent' | null;
  label: string;
  /** Кто подтвердил согласие у заявки ИИ-агента; нет поля или null — строки нет. */
  consent?: 'human' | 'agent' | null;
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

/**
 * Строка согласия в карточке заявки ИИ-агента (слово владельца 11.11):
 * подтвердил ли сам человек передачу своих данных на странице заявки или
 * пока есть только слово агента. Оператор знает, с чем звонит; заявку строка
 * не блокирует. У заявок от человека строки нет — он ставил галочку сам.
 */
export function LeadConsentLine({ origin, className = '' }: { origin?: LeadOriginView | null; className?: string }) {
  const consent = origin?.consent;
  if (consent !== 'human' && consent !== 'agent') return null;
  const Icon = consent === 'human' ? ShieldCheck : ShieldAlert;
  return (
    <span className={`inline-flex items-start gap-1 ${className}`} data-lead-consent={consent}>
      <Icon className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{CONSENT_WORDS[consent]}</span>
    </span>
  );
}
