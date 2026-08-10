/**
 * GET /api/routes/[id]/verdict
 *
 * Вердикт по маршруту на сегодня: Идти / Осторожно / Не сегодня.
 *
 * Правила — lib/routes/go-verdict, сигналы — lib/routes/collect-signals.
 * Здесь только доставка: ответ отдаёт и вердикт, и сами сигналы, потому что
 * экран показывает не только слово, но и то, из чего оно посчитано. Вердикт
 * без фактов под ним — это уверенность без предъявления оснований, а мы уже
 * знаем, чем такое кончается.
 *
 * `null` в сигналах доезжает до клиента как `null` и означает «не смогли
 * узнать». JSON это различение держит, и терять его на границе нельзя.
 */

import { collectRouteSignals } from '@/lib/routes/collect-signals';
import { goVerdict, VERDICT_LABELS } from '@/lib/routes/go-verdict';

// AUTH: Public — как offline-bundle и offline-readiness рядом: данные
// маршрута и обстановка по нему публичные.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'Некорректный идентификатор маршрута' }, { status: 400 });
  }

  // Сборщик сам возвращает всё-null, когда маршрут не найден или база
  // отказала. Отдельного 404 здесь нет намеренно: для человека оба случая
  // значат одно — «мы не знаем», и вердикт скажет это прямо, вместо того
  // чтобы экран остался пустым.
  const signals = await collectRouteSignals(id);
  const verdict = goVerdict(signals);

  return Response.json({
    verdict: { ...verdict, label: VERDICT_LABELS[verdict.status] },
    signals,
  });
}
