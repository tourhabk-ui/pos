/**
 * GET /api/cron/document-expiry
 *
 * Раз в сутки: документы туристов, чей срок кончается в ближайшие 30 дней,
 * получают одно напоминание в Telegram. После отправки ставится отметка —
 * иначе одно и то же письмо придёт каждый день до самого истечения.
 *
 * Зачем. Просроченная страховка или паспорт вскрываются на маршруте, а не
 * дома: без действующего документа не пустят в группу и не оформят страховой
 * случай. Загрузка документов работала давно (`/api/tourist/documents`), а
 * читатели срока — `getExpiringDocuments` и `markDocumentReminderSent` — были
 * написаны и не звались ниоткуда: платформа знала о просроченном паспорте и
 * молчала (перепись 22.08.2026).
 *
 * Прогон, который ничего не разобрал при непустом входе, считается ОТКАЗОМ,
 * а не успехом (CLAUDE.md §4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getExpiringDocuments, markDocumentReminderSent } from '@/lib/auth/tourist-helpers';
import { notifyTouristDocumentExpiring } from '@/lib/telegram/booking-notify';

export const dynamic = 'force-dynamic';

/** За сколько дней предупреждать. */
const HORIZON_DAYS = 30;

interface OwnerRow {
  user_id: string;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET не настроен' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = new Date();
  try {
    // Кого вообще касается: туристы, у которых есть документ с приближающимся
    // сроком и без отметки о напоминании. Детали берёт getExpiringDocuments —
    // одно правило срока на платформу, а не второе такое же здесь.
    const { rows: owners } = await pool.query<OwnerRow>(
      `SELECT DISTINCT tp.user_id::text AS user_id
         FROM tourist_documents td
         JOIN tourist_profiles tp ON tp.id = td.tourist_id
        WHERE td.expiry_date IS NOT NULL
          AND td.expiry_date <= CURRENT_DATE + ($1 || ' days')::interval
          AND COALESCE(td.reminder_sent, FALSE) = FALSE`,
      [String(HORIZON_DAYS)],
    );

    let notified = 0;
    let marked = 0;
    const failures: string[] = [];

    for (const owner of owners) {
      let docs;
      try {
        docs = await getExpiringDocuments(owner.user_id, HORIZON_DAYS);
      } catch (err) {
        failures.push(`${owner.user_id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const doc of docs) {
        if (doc.reminder_sent === true) continue;
        const expiry = doc.expiry_date === null || doc.expiry_date === undefined
          ? null
          : String(doc.expiry_date).slice(0, 10);
        if (expiry === null) continue; // без срока предупреждать не о чем

        const daysLeft = Math.ceil(
          (new Date(expiry).getTime() - startedAt.getTime()) / 86_400_000,
        );
        notifyTouristDocumentExpiring(owner.user_id, {
          documentType: String(doc.document_type ?? 'document'),
          expiryDate: expiry,
          daysLeft,
        });
        notified++;

        try {
          await markDocumentReminderSent(String(doc.id));
          marked++;
        } catch (err) {
          // Не отметили — значит завтра напомним снова. Это лучше молчания,
          // но знать об этом надо.
          failures.push(`отметка ${String(doc.id)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Нашли кого предупредить и не предупредили никого — это отказ.
    const ok = owners.length === 0 || notified > 0;
    void recordCronRun('document-expiry', startedAt.getTime(), ok ? 'success' : 'failed', {
      items: notified,
      error: failures.length > 0 ? failures.slice(0, 3).join('; ') : undefined,
    });

    return NextResponse.json({
      success: ok,
      owners: owners.length,
      notified,
      marked,
      failures,
      horizon_days: HORIZON_DAYS,
    }, { status: ok ? 200 : 500 });
  } catch (error) {
    void recordCronRun('document-expiry', startedAt.getTime(), 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({
      success: false,
      error: 'Напоминания о документах не разосланы',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
