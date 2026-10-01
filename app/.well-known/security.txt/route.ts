/**
 * GET /.well-known/security.txt — куда сообщить об уязвимости (RFC 9116).
 * Роутом, а не файлом в public/: срок Expires считается от запроса и не
 * истекает молча. Текст — lib/security/security-txt.
 */
import { securityTxt } from '@/lib/security/security-txt';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(securityTxt(new Date(), getPublicBaseUrl()), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
