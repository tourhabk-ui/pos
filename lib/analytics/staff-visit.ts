/**
 * Заход админа или оператора — свой, не турист (владелец 24.10).
 *
 * Роль читается из уже выданного auth_token. Турист, гид, жильё, трансфер,
 * агент и прокат в этот список не входят: владелец назвал админов и
 * операторов. Чужой или битый токен — не свой. Секрета нет — тоже не свой,
 * и это пишется в лог: молчаливый отказ снова посчитал бы сотрудника туристом.
 *
 * Идентификатор и почта из токена никуда не пишутся.
 */
import { verifyToken } from '@/lib/auth/jwt';

const STAFF_ROLES = new Set(['admin', 'operator']);

function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

export async function isStaffOwnVisit(cookieHeader: string | null | undefined): Promise<boolean> {
  const token = cookieValue(cookieHeader, 'auth_token');
  if (!token) return false;
  try {
    const payload = await verifyToken(token);
    return payload != null && STAFF_ROLES.has(payload.role);
  } catch (err) {
    console.error('[staff-visit] роль не проверена:', err instanceof Error ? err.message : 'ошибка');
    return false;
  }
}
