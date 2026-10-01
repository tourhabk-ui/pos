/**
 * Текст /.well-known/security.txt (RFC 9116) — куда сообщить об уязвимости.
 *
 * Разбор публичного аудита 01.10: у сайта с публичным MCP, заявками и SOS
 * этого файла не было, и исследователь, нашедший дыру, не знал, кому писать.
 *
 * Срок (Expires) считается от запроса, а не вписан датой: статичная дата
 * однажды молча истекла бы, а файл с просроченным Expires по RFC считается
 * недействительным — снаружи он выглядел бы как отсутствующий.
 *
 * Адрес — из реквизитов, не вписан руками: сменится почта поддержки —
 * сменится и здесь.
 */
import { REQUISITES } from '@/lib/legal/requisites';

/** Срок действия: RFC 9116 советует меньше года. */
export const SECURITY_TXT_TTL_DAYS = 180;

export function securityTxt(now: Date, base: string): string {
  const expires = new Date(now.getTime() + SECURITY_TXT_TTL_DAYS * 86_400_000);
  const site = base.replace(/\/$/, '');
  return [
    `Contact: mailto:${REQUISITES.emailSupport}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    'Preferred-Languages: ru, en',
    `Canonical: ${site}/.well-known/security.txt`,
    '',
  ].join('\n');
}
