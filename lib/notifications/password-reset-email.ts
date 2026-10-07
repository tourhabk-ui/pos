/**
 * Письмо со ссылкой сброса пароля.
 *
 * Не берёт passwordResetEmail из email-templates.ts: тот макет подписан
 * «KamHub» — именем, которого на платформе больше нет (бренд — Ведар, см.
 * legal-brand-vedar). Имя человека — через escapeHtml: его вводил он сам при
 * регистрации, а читает письмо почтовый клиент.
 */

import { escapeHtml } from '@/lib/text/escape-html';

export function passwordResetEmailVedar(data: {
  userName: string;
  resetLink: string;
  ttlText: string;
}): { subject: string; html: string; text: string } {
  const name = escapeHtml(data.userName);
  const link = escapeHtml(data.resetLink);
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Ведар — сброс пароля</title></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#F5F0EB;color:#1A1714;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:8px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6B6560;">Ведар</p>
        <h1 style="margin:0 0 20px;font-size:22px;">Сброс пароля</h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Здравствуйте, ${name}.</p>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Для вашего аккаунта на Ведаре запрошен сброс пароля. Чтобы задать новый, откройте ссылку:</p>
        <p style="margin:24px 0;text-align:center;">
          <a href="${link}" style="display:inline-block;background:#C2410A;color:#FFFFFF;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;">Задать новый пароль</a>
        </p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#6B6560;word-break:break-all;">Если кнопка не открывается, скопируйте адрес: ${link}</p>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#6B6560;">Ссылка действует ${escapeHtml(data.ttlText)} и годится один раз.</p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#6B6560;">Если вы не запрашивали сброс, ничего делать не нужно: пароль не изменится.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const text = [
    `Здравствуйте, ${data.userName}.`,
    '',
    'Для вашего аккаунта на Ведаре запрошен сброс пароля. Чтобы задать новый, откройте ссылку:',
    data.resetLink,
    '',
    `Ссылка действует ${data.ttlText} и годится один раз.`,
    'Если вы не запрашивали сброс, ничего делать не нужно: пароль не изменится.',
  ].join('\n');
  return { subject: 'Ведар: сброс пароля', html, text };
}
