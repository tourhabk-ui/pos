/**
 * lib/observability/swallowed.ts
 *
 * Отказ, который поймали, обязан назваться (§4.0): ловить можно, молчать
 * нельзя. Пустой `catch` превращает поломку в «данных нет», и она живёт
 * ровно столько, сколько никто не смотрит, — поиск мест Кузьмича прожил так
 * полтора месяца.
 *
 * Одна реализация на платформу: правило, написанное в трёх местах, — это три
 * правила, и они разойдутся (§12). Область (`scope`) идёт в скобках, чтобы
 * строку в логе можно было отобрать по подсистеме.
 */
import { redactPII } from '@/lib/security/pii-redact';

export function logSwallowedFailure(scope: string, source: string, err: unknown): void {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code) : 'нет кода';
  console.error(`[${scope}] ${source} не выполнен`, {
    code,
    // Текст ошибки бывает чужим: SMTP повторяет адрес получателя («550
    // <…@…> rejected»), драйвер — значение ключа. Почта и телефон человека
    // в лог целиком не идут (pd-guard §7) — маска та же, что перед моделью.
    message: redactPII(err instanceof Error ? err.message : String(err)),
  });
}
