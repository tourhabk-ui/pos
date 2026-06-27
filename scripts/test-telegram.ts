/**
 * Проверка Telegram-токена: отправляет тестовое сообщение и пробует smoke alert.
 * Запуск: npx tsx scripts/test-telegram.ts
 * Требует: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID в .env.local
 */
import 'dotenv/config';

const print = (msg: string) => process.stdout.write(msg + '\n');
const printErr = (msg: string) => process.stderr.write(msg + '\n');

async function sendMessage(token: string, chatId: string, text: string) {
  const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    printErr('Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID — добавь в .env.local');
    process.exit(1);
  }

  print(`Token: ${token.slice(0, 10)}...`);
  print(`ChatId: ${chatId}`);

  // 1. Базовый пинг
  print('\n[1/2] Отправка тестового сообщения...');
  const ping = await sendMessage(
    token, chatId,
    `<b>Тест токена Ведар</b>\n` +
    `Время: ${new Date().toISOString()}\n` +
    `Среда: ${process.env.NODE_ENV ?? 'development'}\n` +
    `Smoke test smoke-test.ts — настоящий алерт ниже ↓`,
  );
  print(`Пинг: ${ping.status === 200 ? '✓ OK' : `✗ ${ping.status}`}`);
  if (ping.status !== 200) {
    printErr(`Ошибка: ${JSON.stringify(ping.body)}`);
    process.exit(1);
  }

  // 2. Симуляция smoke FAIL alert (как при silent_fail в реальном агенте)
  print('\n[2/2] Симуляция smoke FAIL alert...');
  const fakeIds = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
  const alertResult = await sendMessage(
    token, chatId,
    `<b>SMOKE FAIL: Editor — тихая ошибка</b>\n` +
    `Агент сообщил: <b>5</b> улучшено (IDs: ${fakeIds.join(', ')})\n` +
    `Реально в БД (places + kamchatka_routes по этим ID): <b>0</b> строк с описанием\n` +
    `[ТЕСТ — не реальная ошибка, это проверка токена и chat_id]`,
  );
  print(`Alert: ${alertResult.status === 200 ? '✓ OK' : `✗ ${alertResult.status}`}`);
  if (alertResult.status !== 200) {
    printErr(`Ошибка: ${JSON.stringify(alertResult.body)}`);
    process.exit(1);
  }

  print('\n✓ Оба сообщения доставлены. Токен работает, chat_id верный.');
}

main().catch((err) => {
  printErr(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
