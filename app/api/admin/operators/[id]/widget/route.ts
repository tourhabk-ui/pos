/**
 * PATCH /api/admin/operators/[id]/widget
 * Update widget settings for a partner (enable/disable, allowed domains, config).
 *
 * GET /api/admin/operators/[id]/widget
 * Return current widget settings.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { isUuid } from '@/lib/text/slugify';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  widget_enabled: z.boolean().optional(),
  widget_domains: z.array(z.string().max(200)).max(20).optional(),
  widget_config:  z.object({
    greeting:    z.string().max(300).optional(),
    accentColor: z.string().max(20).optional(),
    buttonText:  z.string().max(50).optional(),
    position:    z.enum(['left', 'right']).optional(),
    // Вступление формы заявки — отдельно от приветствия чата (аудит 15.10,
    // WID-config): читает /api/widget/partner → /widget/lead-form.
    formIntro:   z.string().max(300).optional(),
  }).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;
  // Тот же формат, что у PATCH ниже: не-uuid база отвергла бы 22P02 → 500.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Неверный идентификатор оператора' }, { status: 400 });
  }

  const { rows } = await pool.query(
    `SELECT slug, widget_enabled, widget_domains, widget_config
     FROM partners WHERE id = $1`,
    [id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Оператор не найден' }, { status: 404 });
  }

  const row = rows[0] as {
    slug: string | null;
    widget_enabled: boolean;
    widget_domains: string[];
    widget_config: Record<string, string> | null;
  };

  return NextResponse.json({ success: true, data: row });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;
  // id — uuid партнёра. Не-uuid база отвергает 22P02, и админ видел «ошибка
  // базы» (500) вместо «неверный адрес». Формат проверяется до запроса
  // (аудит 15.10, W3-widget, ревью WID-config). isUuid — канонический вид с
  // дефисами, любой hex, без требования версии RFC: так пишет id база.
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Неверный идентификатор оператора' }, { status: 400 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' },
      { status: 400 }
    );
  }

  const { widget_enabled, widget_domains, widget_config } = parsed.data;

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];

  if (widget_enabled !== undefined) {
    vals.push(widget_enabled);
    sets.push(`widget_enabled = $${vals.length}`);
  }
  if (widget_domains !== undefined) {
    vals.push(widget_domains);
    sets.push(`widget_domains = $${vals.length}`);
  }
  if (widget_config !== undefined) {
    // Слияние, а не замена: присланные ключи ложатся поверх записанных,
    // остальные живут дальше. До 15.10 конфиг заменялся целиком, и смена
    // одного цвета стирала приветствие, подпись кнопки и отступ, которые
    // ставили миграции 1104/1105/1260 (находка аудита 15.10 WID-config).
    // Не-объект в колонке (NULL, массив) — как пустой конфиг: `||` с массивом
    // дописал бы элемент, а не ключ.
    vals.push(JSON.stringify(widget_config));
    sets.push(
      `widget_config = (CASE WHEN jsonb_typeof(widget_config) = 'object' THEN widget_config ELSE '{}'::jsonb END)`
      + ` || $${vals.length}::jsonb`,
    );
  }

  if (sets.length === 1) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 });
  }

  vals.push(id);
  // Ответ называет исход: тумблер в админке верит ему, а не своему клику.
  // Ноль строк — оператора нет, отказ базы — «не сохранено», а не «успех».
  let updated: number;
  try {
    const res = await pool.query(
      `UPDATE partners SET ${sets.join(', ')} WHERE id = $${vals.length}`,
      vals
    );
    updated = res.rowCount ?? 0;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[admin/widget] настройки виджета не сохранены:', `operator=${id}`, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ error: 'Настройки виджета не сохранены — ошибка базы' }, { status: 500 });
  }
  if (updated === 0) {
    return NextResponse.json({ error: 'Оператор не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
