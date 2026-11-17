/**
 * lib/mcp/human-confirmation.ts — слова черновика заявки внешнего агента
 * (#3399, п. 4).
 *
 * Заявку MCP и A2A отправляет сам человек (слово владельца 15.11 «Делай»):
 * вызов агента проходит все проверки, но ничего не пишет и никому не
 * передаёт; заявка откладывается (lib/mcp/pending-request), агент получает
 * черновик и ссылку на /confirm. Там человек видит, что и кому уйдёт, ставит
 * галочку согласия и нажимает «Отправить» — только тогда заявка записывается,
 * а согласие пишется как его (источник request-page), а не как заявление
 * агента.
 *
 * До этого (#3414) был код подтверждения для второго вызова. Ревью
 * безопасности показало, что код гасит тот же агент: доказательством того,
 * что «да» сказал человек, он не был. Ссылка на страницу Ведара — другой
 * домен доверия: нажать «Отправить» агент за человека не может, не открыв
 * страницу сам, и это уже не «тот же вызов».
 *
 * Здесь только тексты; хранение — pending-request, отправка — pending-confirm.
 */
import { PENDING_REQUEST_TTL_MIN } from '@/lib/mcp/pending-request';

/** Что агент делает с черновиком: отдать человеку ссылку. */
export function askHumanToSend(url: string): string {
  return 'Черновик: заявка ещё НЕ создана и никому не передана. Отправить её может только сам человек: '
    + `дай ему эту ссылку — ${url} — на странице Ведара он увидит, что и кому уйдёт, и нажмёт «Отправить» `
    + `(ссылка действует ${PENDING_REQUEST_TTL_MIN} мин). Не открывай ссылку и не нажимай за человека. `
    + `EN: Draft only — not sent. Only the person can send it: give them this link — ${url} — they will see what goes to whom and press «Отправить» (Send).`;
}

/** Черновик заявки: что уйдёт и кому — без имени и телефона (ответ идёт в модель). */
export function draftText(would: string, recipient: string | null): string {
  const who = recipient ?? 'менеджеру Ведара';
  return `Черновик заявки (не отправлена): ${would} Имя и телефон, которые вы передали, уйдут ${who}.`;
}

/**
 * Тот же порядок словами для /llms.txt и /llms-en.txt (16.11): файлы для
 * агентов описывали заявку по-старому — «после успешного вызова скажи
 * „заявка создана“», хотя вызов с 15.11 даёт только черновик и ссылку.
 * С 17.11 тем же путём идёт и прокат (слово владельца «Да, на /confirm»).
 */
export function agentSendRuleRu(base: string): string {
  return `Вызов заявки её НЕ отправляет: ответ — черновик и ссылка на страницу Ведара ${base}/confirm `
    + `(действует ${PENDING_REQUEST_TTL_MIN} мин). Дай ссылку человеку: там он видит, что и кому уйдёт, отмечает согласие `
    + 'на обработку данных и сам нажимает «Отправить» — только тогда заявка записана. Ссылку не открывай и не нажимай за человека.';
}

export function agentSendRuleEn(base: string): string {
  return `A request call does NOT send the request: it returns a draft and a link to a Vedar page, ${base}/confirm `
    + `(valid ${PENDING_REQUEST_TTL_MIN} min). Give the link to the person: there they see what goes to whom, tick consent `
    + 'to personal-data processing and press «Отправить» (Send) themselves — only then is the request recorded. Never open the link or press Send for them.';
}
