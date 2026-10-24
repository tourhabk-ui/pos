/**
 * operator_rental_fleet — машины прокатчика из его прайса, для Кузьмича в
 * привязанном чате (MAX, Telegram). Только чтение.
 *
 * Партнёр — из привязанного чата, не из аргументов модели: чужой прайс не
 * прочитать. Цена, залог и видимость — колонки car_rental_offers (схема 1317).
 * Чего в строке нет, текст так и говорит: залог NULL — «не записан», а не
 * «залога нет». Итоговую сумму за несколько суток не считаем: прайс её не
 * называет.
 *
 * Скрытые строки (is_active = false) прокатчик видит: это его прайс, не
 * витрина. На сайте прокатчик может быть отдельно спрятан паузой
 * (lib/rental/site-pause) — это сказано отдельно, а не подменой «скрыта».
 */

import { pool } from '@/lib/db-pool';
import { containsPattern } from '@/lib/db/like';
import { bodyKindWord, driverWord, priceOnScreen, type RentalBodyKind, type RentalDriver } from '@/lib/rental/rental-format';
import { rentalHiddenOnSite, RENTAL_SITE_PAUSE } from '@/lib/rental/site-pause';
import { escapeHtml } from '@/lib/text/escape-html';
import { formatRub } from '@/lib/transfers/charter-format';

export const RENTAL_FLEET_TOOL_NAME = 'operator_rental_fleet';

export const RENTAL_FLEET_TOOL = {
  type: 'function' as const,
  function: {
    name: RENTAL_FLEET_TOOL_NAME,
    description:
      'Свои машины прокатчика из прайса: модель, цена за сутки за машину, залог, видна ли строка в прайсе. '
      + 'Зови на «мои машины», «автопарк», «какой залог», «сколько стоит сутки». Занятость и итоговую сумму не возвращает.',
    parameters: {
      type: 'object',
      properties: {
        car: { type: 'string', description: 'Необязательно: часть названия машины' },
      },
    },
  },
};

const FLEET_LIMIT = 30;

interface FleetRow {
  title: string;
  body_kind: string;
  price_rub_per_day: number;
  price_is_from: boolean;
  deposit_rub: number | null;
  is_active: boolean;
  driver: string;
}

const BODY_KINDS = new Set<RentalBodyKind>(['car', 'suv', 'minibus', 'offroad_truck', 'vahtovka']);

function kindWord(kind: string): string {
  return BODY_KINDS.has(kind as RentalBodyKind) ? bodyKindWord(kind as RentalBodyKind) : `род «${escapeHtml(kind)}»`;
}

function driverLine(driver: string): string {
  if (driver === 'self' || driver === 'optional') return driverWord(driver as RentalDriver);
  return `водитель в прайсе записан как «${escapeHtml(driver)}»`;
}

function depositLine(rub: number | null): string {
  return rub === null ? 'залог не записан' : `залог ${formatRub(rub)}`;
}

/** Короткий запрос «покажи машины», на который отвечаем прайсом без модели. */
export function isFleetAsk(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
  if (t.length === 0 || t.length > 60) return false;
  return /^(?:покажи |мой |мои |список )?автопарк$/.test(t)
    || /^(?:покажи |мои |список )?машины$/.test(t)
    || t === 'прайс'
    || t === 'покажи прайс';
}

/** Текст прокатчику. Отказ базы — «не смог прочитать», не «машин нет». */
export async function runOperatorRentalFleet(
  partnerId: string,
  partnerName: string,
  slug: string | null,
  args: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<string> {
  const q = typeof args.car === 'string' ? args.car.trim().slice(0, 80) : '';
  let rows: FleetRow[];
  try {
    const { rows: found } = await pool.query<FleetRow>(
      `SELECT title, body_kind, price_rub_per_day, price_is_from, deposit_rub, is_active, driver
         FROM car_rental_offers
        WHERE partner_id = $1::uuid
          AND ($2::text = '' OR title ILIKE $3::text)
        ORDER BY is_active DESC, sort_order, title
        LIMIT ${FLEET_LIMIT}`,
      [partnerId, q, containsPattern(q)],
    );
    rows = found;
  } catch (err) {
    console.error('[rental-fleet] прайс не прочитан, SQLSTATE', (err as { code?: string })?.code ?? 'нет');
    return 'НЕ УДАЛОСЬ ПРОЧИТАТЬ прайс проката — не называй машины, цены и залог; предложи спросить позже.';
  }

  const pause = slug && rentalHiddenOnSite(slug, new Date(nowMs))
    ? `На сайте для людей прокат сейчас скрыт (${RENTAL_SITE_PAUSE.returnsOn} вернётся на витрину). Страница по прямой ссылке открыта. Это про витрину, не про отдельные машины.`
    : null;

  const editHint = 'Новую цену за сутки или описание напишите отдельным сообщением: «цена <название как в списке> <рубли>» или «описание <название>: текст». Это черновик: на сайте остаётся текущая строка, пока правку не одобрят. Фото эта команда не меняет.';

  if (rows.length === 0) {
    const empty = q
      ? `В прайсе нет машины, в названии которой есть «${escapeHtml(q)}».`
      : 'В прайсе нет ни одной машины.';
    const head = pause ? `${empty}\n${pause}` : empty;
    return `${head}\n${editHint}`;
  }

  const lines = [
    `Машины проката «${escapeHtml(partnerName)}» из прайса. Цена — за сутки за машину. Итоговой суммы за несколько суток прайс не называет.`,
  ];
  if (pause) lines.push(pause);
  for (const r of rows) {
    const price = priceOnScreen({ priceRubPerDay: r.price_rub_per_day, priceIsFrom: r.price_is_from === true });
    const visible = r.is_active ? 'в прайсе' : 'скрыта из прайса';
    lines.push(`- ${escapeHtml(r.title)} | ${kindWord(r.body_kind)} | ${price} | ${depositLine(r.deposit_rub)} | ${visible} | ${driverLine(r.driver)}`);
  }
  lines.push(editHint);
  return lines.join('\n');
}
