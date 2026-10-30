/**
 * Прайс перевозчика из кабинета (#2862 этап C, миграция 1355).
 *   GET  /api/hub/carrier/prices — свои строки прайса (и скрытые) и черновики
 *   POST /api/hub/carrier/prices — черновик: правка строки (priceId) или новая строка
 *
 * Живой прайс отсюда не меняется: черновик ждёт одобрения администратора в
 * /hub/admin/moderation (как у проката, 1327). Каждый список GET может не
 * прочитаться отдельно — тогда он null, а не пустой (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier } from '@/lib/transfers/carrier-auth';
import {
  CHARTER_LINE_KINDS, CHARTER_VEHICLE_KINDS, PRICE_CONDITIONS_MAX, PRICE_RUB_MAX, PRICE_TEXT_MAX,
} from '@/lib/transfers/price-edit';
import {
  findOwnPriceRowById, loadOwnDrafts, loadOwnPriceRows, saveNewPriceDraft, savePricePatch,
} from '@/lib/transfers/price-edit-store';

export const dynamic = 'force-dynamic';

const text = (max: number) => z.string().trim().min(1).max(max);
const price = z.number().int().min(1, 'Цена — целое число рублей больше нуля').max(PRICE_RUB_MAX);

const EditSchema = z.object({
  priceId: z.string().uuid('Некорректный id строки прайса'),
  priceRub: price.nullable().optional(),
  priceNote: text(PRICE_TEXT_MAX).nullable().optional(),
  conditions: text(PRICE_CONDITIONS_MAX).nullable().optional(),
  isActive: z.boolean().nullable().optional(),
});

const NewSchema = z.object({
  vehicleKind: z.enum(CHARTER_VEHICLE_KINDS as [string, ...string[]]),
  lineKind: z.enum(CHARTER_LINE_KINDS as [string, ...string[]]),
  fromText: text(PRICE_TEXT_MAX).nullable().optional(),
  toText: text(PRICE_TEXT_MAX).nullable().optional(),
  priceRub: price,
  priceNote: text(PRICE_TEXT_MAX).nullable().optional(),
  conditions: text(PRICE_CONDITIONS_MAX).nullable().optional(),
  validYear: z.number().int().min(2020).max(2100).nullable().optional(),
});

const BodySchema = z.union([EditSchema, NewSchema], { message: 'Некорректные данные черновика' });

const SHAPE_TEXT: Record<string, string> = {
  destination_needs_texts: 'У направления нужны «откуда» и «куда»',
  rate_has_texts: 'У цены за час, за день и доплаты направления нет — поля «откуда» и «куда» пустые',
  bad_price: 'Цена — целое число рублей больше нуля',
  text_long: 'Текст длиннее строки прайса',
  bad_year: 'Год прайса — от 2020 до 2100',
};

export async function GET(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;
  const [rows, drafts] = await Promise.all([loadOwnPriceRows(carrier.partnerId), loadOwnDrafts(carrier.partnerId)]);
  return NextResponse.json({
    success: true,
    data: {
      rows: rows.outcome === 'ok' ? rows.rows : null,
      drafts: drafts.outcome === 'ok' ? drafts.drafts : null,
    },
  });
}

export async function POST(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные черновика' },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if ('priceId' in body) {
    const found = await findOwnPriceRowById(carrier.partnerId, body.priceId);
    if (found.outcome === 'db_error') {
      return NextResponse.json({ success: false, error: 'Не смог прочитать строку прайса. Черновик не записан.' }, { status: 503 });
    }
    if (found.outcome !== 'one') {
      return NextResponse.json({ success: false, error: 'Такой строки в вашем прайсе нет' }, { status: 404 });
    }
    const saved = await savePricePatch({
      partnerId: carrier.partnerId,
      row: found.row,
      patch: {
        priceRub: body.priceRub ?? null,
        priceNote: body.priceNote ?? null,
        conditions: body.conditions ?? null,
        isActive: body.isActive ?? null,
      },
    });
    if (saved.outcome === 'empty') {
      return NextResponse.json({ success: false, error: 'Черновик ничего не меняет — записывать нечего' }, { status: 400 });
    }
    if (saved.outcome === 'db_error') {
      return NextResponse.json({ success: false, error: 'Не смог записать черновик. Прайс на сайте не изменён.' }, { status: 503 });
    }
    return NextResponse.json({
      success: true,
      data: { id: saved.saved.id, label: saved.saved.label, draft: saved.saved.draft },
      message: `Черновик записан: ${saved.saved.label}. На сайте прежняя строка — правка появится после одобрения.`,
    }, { status: 201 });
  }

  const saved = await saveNewPriceDraft({
    partnerId: carrier.partnerId,
    row: {
      vehicleKind: body.vehicleKind as (typeof CHARTER_VEHICLE_KINDS)[number],
      lineKind: body.lineKind as (typeof CHARTER_LINE_KINDS)[number],
      fromText: body.fromText ?? null,
      toText: body.toText ?? null,
      priceRub: body.priceRub,
      priceNote: body.priceNote ?? null,
      conditions: body.conditions ?? null,
      validYear: body.validYear ?? null,
    },
  });
  if (saved.outcome === 'bad_shape') {
    return NextResponse.json({ success: false, error: SHAPE_TEXT[saved.reason] ?? 'Форма строки не сошлась' }, { status: 400 });
  }
  if (saved.outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не смог записать черновик. Прайс на сайте не изменён.' }, { status: 503 });
  }
  return NextResponse.json({
    success: true,
    data: { id: saved.id, label: saved.label },
    message: `Черновик новой строки записан: ${saved.label}. На сайте появится после одобрения.`,
  }, { status: 201 });
}
