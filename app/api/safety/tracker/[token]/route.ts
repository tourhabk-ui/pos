/**
 * POST /api/safety/tracker/[token] — точка со спутникового трекера.
 *
 * ── Почему адрес публичный ───────────────────────────────────────────────
 *
 * Спутниковый передатчик не умеет ни JWT, ни OAuth: он (или шлюз вендора)
 * делает один HTTP-запрос по заранее вбитому адресу. Значит доказательством
 * права писать может быть только сам адрес — токен в пути. Отсюда 32 байта
 * энтропии в токене (миграция 983) и запись в реестр публичных маршрутов:
 * Edge обязан пускать сюда анонима, иначе приёмника нет вовсе.
 *
 * Что токен НЕ даёт: он пишет ровно одну строку одной регистрации и не
 * читает ничего. Перебор бессмыслен — угаданный токен позволит подделать
 * координату одного маршрута, и это видно в счётчиках связки.
 *
 * ── Почему отказ записывается, а не только возвращается ──────────────────
 *
 * Человек, подключивший трекер, ответа приёмника не видит НИКОГДА: запрос
 * делает устройство за сотни километров. Если отказ только уйдёт в ответ,
 * для человека «трекер подключён» и «трекер шлёт мусор» будут выглядеть
 * одинаково — молчанием (§4.0). Поэтому и успех, и отказ оседают в строке
 * связки, и экран показывает их словами.
 *
 * ── Чего роут НЕ делает ──────────────────────────────────────────────────
 *
 * Не поднимает тревогу и не трогает эскалацию. Его дело — записать точку;
 * решение о невозврате принимает `checkin-watchdog`, который эти же поля уже
 * читает. Второй судья того же факта разошёлся бы с первым.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { parseTrackerPoint } from '@/lib/safety/tracker-point';

export const dynamic = 'force-dynamic';

interface LinkRow {
  id: string;
  registration_id: string;
  revoked_at: string | null;
  reg_completed_at: string | null;
}

/** Отказ приёма — в строку связки. Молчать нельзя, ответ читает железо. */
async function noteError(linkId: string, reason: string): Promise<void> {
  try {
    await query(
      `UPDATE tracker_links
          SET last_error = LEFT($2, 300), last_error_at = NOW()
        WHERE id = $1`,
      [linkId, reason],
    );
  } catch (err) {
    // Не смогли записать причину — но сам отказ уже произошёл, и терять его
    // в тишине нельзя ни в логе, ни в ответе.
    console.error('[tracker] причина отказа не записалась:', err instanceof Error ? err.message : err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || token.length < 32) {
    return NextResponse.json({ ok: false, error: 'Некорректный токен' }, { status: 404 });
  }

  let link: LinkRow | undefined;
  try {
    const { rows } = await query<LinkRow>(
      `SELECT l.id, l.registration_id::text AS registration_id,
              l.revoked_at::text AS revoked_at,
              r.completed_at::text AS reg_completed_at
         FROM tracker_links l
         JOIN route_registrations r ON r.id = l.registration_id
        WHERE l.token = $1
        LIMIT 1`,
      [token],
    );
    link = rows[0];
  } catch (err) {
    // Отказ базы — это «не смогли принять», а не «точка плохая» (§4.0).
    // Код 503 важен: шлюзы вендоров повторяют отправку на 5xx и не повторяют
    // на 4xx, и перепутать их значит потерять точку насовсем.
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[tracker] связка не прочиталась:', message);
    return NextResponse.json({ ok: false, error: 'Временно не можем принять точку' }, { status: 503 });
  }

  // Несуществующий и отозванный токен отвечают РАЗНО: 404 значит «такого
  // адреса нет», 410 — «был и закрыт». Для того, кто настраивает шлюз, это
  // разные починки.
  if (!link) {
    return NextResponse.json({ ok: false, error: 'Связка не найдена' }, { status: 404 });
  }
  if (link.revoked_at) {
    return NextResponse.json({ ok: false, error: 'Связка отозвана' }, { status: 410 });
  }
  if (link.reg_completed_at) {
    await noteError(link.id, 'маршрут завершён — точки больше не принимаются');
    return NextResponse.json({ ok: false, error: 'Маршрут завершён' }, { status: 410 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Пустое или не-JSON тело: устройство могло прислать форму или текст.
    body = null;
  }

  const verdict = parseTrackerPoint(body);
  if (verdict.kind !== 'ok') {
    await noteError(link.id, `${verdict.kind === 'unknown' ? 'форма не распознана' : 'точка отклонена'}: ${verdict.reason}`);
    return NextResponse.json(
      { ok: false, error: verdict.reason, kind: verdict.kind },
      // 422 в обоих случаях: повтор тем же телом даст тот же ответ, и
      // заставлять шлюз долбиться незачем.
      { status: 422 },
    );
  }

  try {
    // Точка пишется, только если она НЕ СТАРШЕ уже записанной: трекер
    // вываливает накопленное пачкой и порядок в ней не гарантирован, а
    // «последняя известная точка» обязана быть последней по времени, а не
    // по приходу.
    const { rowCount } = await query(
      `UPDATE route_registrations
          SET last_position_lat = $2,
              last_position_lng = $3,
              last_position_at = $4,
              last_position_source = 'tracker',
              updated_at = NOW()
        WHERE id = $1
          AND (last_position_at IS NULL OR last_position_at < $4)`,
      [link.registration_id, verdict.lat, verdict.lng, verdict.at.toISOString()],
    );

    // Счётчик приёма растёт в любом случае: точка ДОШЛА, даже если оказалась
    // не свежее уже записанной. Иначе «связка молчит» показывалось бы у
    // исправного трекера, догоняющего очередь.
    await query(
      `UPDATE tracker_links
          SET points_total = points_total + 1,
              last_point_at = NOW(),
              last_error = NULL,
              last_error_at = NULL
        WHERE id = $1`,
      [link.id],
    );

    return NextResponse.json({
      ok: true,
      // `stored: false` — точка принята, но в маршрут не легла, потому что
      // есть свежее. Это не ошибка и не успех записи: пусть будет видно.
      stored: (rowCount ?? 0) > 0,
      at: verdict.at.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'база не ответила';
    console.error('[tracker] точка не записалась:', message);
    await noteError(link.id, `запись не удалась: ${message}`);
    return NextResponse.json({ ok: false, error: 'Временно не можем принять точку' }, { status: 503 });
  }
}
