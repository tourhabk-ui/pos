/**
 * GET /r/<код> — короткая ссылка агента/креатора: засчитать клик и увести.
 *
 * ── Зачем она (20.09, issue #1978) ────────────────────────────────────────
 *
 * Клик по агентской ссылке считался РОВНО В ОДНОМ месте — при запросе цены
 * тура (`/api/tours/[id]/price`). То есть считался он, только если человек
 * открыл карточку конкретного тура и она успела спросить цену.
 *
 * Блогер так не публикует. Ссылка уходит в описание ролика, в шапку
 * профиля, в пост — и ведёт на главную, на маршрут, на подборку. Ни один
 * такой переход не считался вовсе, и в кабинете у человека стоял ноль
 * кликов при живой аудитории. Ноль, означающий «мы не смотрели», выглядит
 * как ноль, означающий «никто не пришёл» (§4.0), — а это разные вещи, и
 * вторая обидна незаслуженно.
 *
 * ── Почему серверный переход, а не `?ref=` на любой странице ──────────────
 *
 * Ловец `?ref=` работает в браузере: нужен выполненный JavaScript и целый
 * адрес. Мессенджеры и соцсети режут параметры, предпросмотрщики ходят без
 * скриптов. Короткий адрес переживает это: `/r/KH-AGT-1A2B3C` нечего
 * срезать, а клик засчитывается на сервере, до всякого JavaScript.
 *
 * ── Что роут делает и чего не делает ──────────────────────────────────────
 *
 * ПИШЕТ ровно две вещи и обе про клик: строку в журнал событий и счётчик.
 * Ставок, броней и денег не касается. Неизвестный или погашенный код — не
 * ошибка для человека: он просто уходит на главную, и ни одной строки при
 * этом не пишется. Показывать туристу «ссылка недействительна» незачем —
 * он не виноват и починить это не может.
 *
 * IP и user-agent НЕ пишутся, хотя колонки для них есть и соседний счётчик
 * их заполняет. Это персональные данные, и собирать их ради счётчика
 * кликов — плата не по товару: чтобы посчитать переходы, довольно самого
 * факта перехода.
 *
 * Куда уводит: на тур, если ссылка сделана под конкретный тур, иначе на
 * главную. Код передаётся дальше в адресе — его на той странице поймает
 * `ReferralCapture` и запомнит на 30 дней, так что бронь найдёт его даже
 * через неделю.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { isAgentReferralCode } from '@/lib/referral/agent-link';

export const dynamic = 'force-dynamic';

interface LinkRow {
  id: string;
  tour_id: string | null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ code: string }> },
) {
  const { code: raw } = await context.params;
  const code = (raw ?? '').trim().toUpperCase();
  const home = new URL('/', request.url);

  // Форма проверяется ДО базы: чужой или случайный путь не должен приводить
  // к запросу вовсе.
  if (!isAgentReferralCode(code)) {
    return NextResponse.redirect(home, 302);
  }

  let link: LinkRow | null = null;
  try {
    const { rows } = await pool.query<LinkRow>(
      `SELECT id, tour_id::text
         FROM agent_referral_links
        WHERE code = $1
          AND is_active = true
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [code],
    );
    link = rows[0] ?? null;
  } catch (err) {
    // Отказ не глушится (§4.0). Человека при этом всё равно уводим: он
    // пришёл смотреть Камчатку, а не наш журнал событий.
    const sqlstate = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[r/${code}] ссылка не прочитана, SQLSTATE ${sqlstate}:`, err);
    return NextResponse.redirect(home, 302);
  }

  // Кода нет, он выключен или истёк — молча на главную, ничего не пишем.
  if (!link) {
    return NextResponse.redirect(home, 302);
  }

  // Счётчик — best-effort и ПОСЛЕ решения, куда вести: переход человека не
  // должен зависеть от того, записалась ли аналитика.
  try {
    await pool.query(
      `UPDATE agent_referral_links SET clicks = COALESCE(clicks, 0) + 1 WHERE id = $1`,
      [link.id],
    );
    await pool.query(
      `INSERT INTO agent_referral_events (link_id, event_type) VALUES ($1, 'click')`,
      [link.id],
    );
  } catch (err) {
    const sqlstate = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[r/${code}] клик не засчитан, SQLSTATE ${sqlstate}:`, err);
  }

  const target = link.tour_id
    ? new URL(`/marketplace/tours/${link.tour_id}`, request.url)
    : home;
  // Код едет дальше: на той странице его поймает ReferralCapture и запомнит.
  target.searchParams.set('ref', code);

  return NextResponse.redirect(target, 302);
}
