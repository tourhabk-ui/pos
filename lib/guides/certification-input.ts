/**
 * Аттестат, который гид вносит сам, — одна схема для создания и правки.
 *
 * Дата выдачи обязательна: ради неё форма и заведена. Без неё расчёт
 * переаттестации (lib/guides/reattestation.ts) честно отвечает «не знаю», и
 * до срока 01.10 гиду остаётся только баннер «проверьте сами».
 *
 * Ссылки на скан здесь нет намеренно: единственная готовая загрузка
 * (`POST /api/upload`) кладёт файл в ПУБЛИЧНОЕ хранилище, а скан аттестата —
 * документ с персональными данными. Заводить приватное хранилище ради этой
 * формы — отдельное решение; до него администратор сверяет номер с реестром.
 */
import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const CertificationInputSchema = z
  .object({
    name: z.string().trim().min(3, 'Укажите вид аттестации').max(200),
    issuingAuthority: z.string().trim().min(3, 'Укажите, кем выдан аттестат').max(300),
    certificateNumber: z.string().trim().min(1, 'Укажите номер аттестата').max(100),
    issueDate: z.string().refine(isRealDate, 'Дата выдачи — в формате ГГГГ-ММ-ДД'),
    expiryDate: z.string().refine(isRealDate, 'Срок действия — в формате ГГГГ-ММ-ДД').nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    if (v.issueDate > today) {
      ctx.addIssue({ code: 'custom', path: ['issueDate'], message: 'Дата выдачи не может быть в будущем' });
    }
    if (v.expiryDate && v.expiryDate < v.issueDate) {
      ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: 'Срок действия не может закончиться раньше выдачи' });
    }
  });

export type CertificationInput = z.infer<typeof CertificationInputSchema>;

/** Состояние проверки аттестата — из is_verified и reviewed_at (миграция 1016). */
export type CertificationReview = 'verified' | 'pending' | 'rejected';

export function certificationReview(isVerified: boolean, reviewedAt: string | Date | null): CertificationReview {
  if (isVerified) return 'verified';
  return reviewedAt ? 'rejected' : 'pending';
}

/** Выборка аттестата для кабинета гида — одна на GET и ответы записи. */
export const GUIDE_CERT_COLUMNS = `id, name, issuing_authority, certificate_number,
  to_char(issue_date, 'YYYY-MM-DD')  AS issue_date,
  to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
  is_verified, reviewed_at, review_comment, source`;

export interface GuideCertRow {
  id: string;
  name: string;
  issuing_authority: string;
  certificate_number: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  is_verified: boolean | null;
  reviewed_at: string | Date | null;
  review_comment: string | null;
  source: string | null;
}

export function toGuideCert(r: GuideCertRow) {
  return {
    id: r.id,
    name: r.name,
    issuingAuthority: r.issuing_authority,
    certificateNumber: r.certificate_number,
    issueDate: r.issue_date,
    expiryDate: r.expiry_date,
    review: certificationReview(r.is_verified === true, r.reviewed_at),
    reviewComment: r.review_comment,
    source: r.source,
  };
}
