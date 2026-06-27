/**
 * GET /api/telegram/admin?command=health
 * POST /api/telegram/admin
 * Личный admin-бот владельца (@tourhab_bot). Работает 24/7.
 *
 * GET: Тестирование команд без webhook
 *      ?command=health
 *      ?command=stats
 *      ?command=leads
 *      ?command=tip
 *
 * POST: Webhook для получения команд из Telegram
 *       Требует регистрации webhook:
 *       curl -X POST ${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/botTOKEN/setWebhook \
 *         -d url=https://tourhab.ru/api/telegram/admin \
 *         -d secret_token=SECRET
 *
 * Env vars (Timeweb):
 *   TELEGRAM_BOT_TOKEN — токен @kuzmichai_bot
 *   TELEGRAM_OWNER_ID  — Telegram user ID владельца (171286547)
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { callAIWaterfall, callOpenrouter } from '@/lib/ai/providers';
import { postKuzmichRoute, postKuzmichTip } from '@/lib/notifications/telegram-channel';
import type { ChatMessage } from '@/lib/ai/prompts';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { PlatformAgent } from '@/lib/agents';
import { scanAllOperatorGroups } from '@/lib/telegram/operator-availability';

const adminGetLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

// ── Conversation history ──────────────────────────────────────────────────────

async function getAdminHistory(chatId: number): Promise<ChatMessage[]> {
  try {
    const { rows } = await pool.query<{ role: string; content: string }>(
      `SELECT role, content
       FROM tg_conversations
       WHERE chat_id = $1 AND mode = 'admin'
       ORDER BY created_at DESC
       LIMIT 16`,
      [chatId],
    );
    return rows.reverse() as ChatMessage[];
  } catch {
    return [];
  }
}

async function saveAdminMessage(
  chatId: number,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO tg_conversations (chat_id, mode, role, content) VALUES ($1, 'admin', $2, $3)`,
      [chatId, role, content],
    );
  } catch { /* таблица ещё не создана — не блокируем */ }
}

export const dynamic = 'force-dynamic';

// ── Telegram helper ───────────────────────────────────────────────────────────

async function reply(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).catch(() => {});
}

// ── Platform stats ────────────────────────────────────────────────────────────

async function getStats(): Promise<string> {
  try {
    const [leads, bookings, users, tours, held, views] = await Promise.all([
      pool.query<{ total: string; new_cnt: string }>(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE status='new') as new_cnt
         FROM leads`
      ),
      pool.query<{ today: string; pending: string }>(
        `SELECT COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as today,
                COUNT(*) FILTER (WHERE booking_status='new') as pending
         FROM operator_bookings`
      ),
      pool.query<{ cnt: string }>(`SELECT COUNT(*) as cnt FROM users`),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM operator_tours WHERE is_active = true`
      ),
      pool.query<{ cnt: string; amt: string }>(
        `SELECT COUNT(*) as cnt,
                COALESCE(SUM(retail_amount),0) as amt
         FROM tour_payments WHERE status='HELD'`
      ),
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= CURRENT_DATE`
      ).catch(() => ({ rows: [{ cnt: 'n/a' }] })),
    ]);

    const heldAmt = parseFloat(held.rows[0]?.amt ?? '0');
    return [
      `Лиды: ${leads.rows[0]?.total ?? 0} всего, ${leads.rows[0]?.new_cnt ?? 0} новых`,
      `Брони сегодня: ${bookings.rows[0]?.today ?? 0} | ожидают: ${bookings.rows[0]?.pending ?? 0}`,
      `HELD-платежи: ${held.rows[0]?.cnt ?? 0} шт. на ${heldAmt.toLocaleString('ru-RU')} руб`,
      `Пользователей: ${users.rows[0]?.cnt ?? 0} | Туров: ${tours.rows[0]?.cnt ?? 0}`,
      `Просмотров сегодня: ${views.rows[0]?.cnt ?? 0}`,
    ].join('\n');
  } catch (e) {
    return `Ошибка БД: ${e instanceof Error ? e.message : 'unknown'}`;
  }
}

async function getLeads(): Promise<string> {
  try {
    const res = await pool.query<{
      name: string; phone: string; status: string;
      route_title: string | null; created_at: Date;
    }>(
      `SELECT name, phone, status, route_title, created_at
       FROM leads ORDER BY created_at DESC LIMIT 8`
    );
    if (!res.rows.length) return 'Лидов нет';
    return res.rows.map(l =>
      `${l.name} | ${l.phone} | ${l.status}${l.route_title ? ' | ' + l.route_title.slice(0, 25) : ''}`
    ).join('\n');
  } catch { return 'Ошибка получения лидов'; }
}

// ── AI health check ───────────────────────────────────────────────────────────

async function checkHealth(): Promise<string> {
  const ping: ChatMessage[] = [
    { role: 'system', content: 'Ты помощник.' },
    { role: 'user', content: 'ок' },
  ];

  const probe = async (fn: (m: ChatMessage[]) => Promise<string | null>): Promise<boolean> => {
    try {
      const r = await Promise.race([
        fn(ping),
        new Promise<null>((res) => setTimeout(() => res(null), 7000)),
      ]);
      return !!r;
    } catch { return false; }
  };

  const orOk = await probe(callOpenrouter);

  // DB checks
  const issues: string[] = [];
  try {
    const held = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM tour_payments
       WHERE status='HELD' AND release_after < NOW() - INTERVAL '2 hours'`
    );
    const n = parseInt(held.rows[0]?.cnt ?? '0', 10);
    if (n > 0) issues.push(`${n} HELD-платежей просрочены`);
  } catch { issues.push('Ошибка проверки платежей'); }

  try {
    const stuck = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM leads WHERE status='new' AND created_at < NOW() - INTERVAL '6 hours'`
    );
    const n = parseInt(stuck.rows[0]?.cnt ?? '0', 10);
    if (n > 3) issues.push(`${n} лидов без обработки > 6ч`);
  } catch { /* skip */ }

  return [
    `AI: OpenRouter=${orOk ? 'OK' : 'X'}`,
    `БД: ${issues.length === 0 ? 'OK' : issues.join('; ')}`,
    `Сайт: https://tourhab.ru`,
  ].join('\n');
}

// ── Claude digest ─────────────────────────────────────────────────────────────

async function runDigest(): Promise<string> {
  const stats = await getStats();
  const date = new Date().toLocaleDateString('ru-RU', {
    timeZone: 'Asia/Kamchatka', day: 'numeric', month: 'long',
  });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Ты AI-директор туристической платформы TourHab (Камчатка).
Анализируй метрики кратко. Дай 1 строку общей оценки и 3 приоритета на день.`,
    },
    {
      role: 'user',
      content: `Метрики за ${date}:\n${stats}\n\nДай оценку и 3 приоритета.`,
    },
  ];

  const answer = await callAIWaterfall(messages);
  return answer ?? 'AI временно недоступен';
}

// ── Push test (end-to-end: VAPID → push_subscriptions → телефон) ─────────────

async function testPush(ownerChatId: number): Promise<void> {
  const lines: string[] = ['<b>Push-стек диагностика:</b>', ''];

  // 1. VAPID ключи
  const pubKey  = process.env.NEXT_PUBLIC_VAPID_KEY?.trim();
  const privKey = process.env.VAPID_PRIVATE_KEY?.trim();
  lines.push(`VAPID публичный: ${pubKey ? `✅ ${pubKey.slice(0, 12)}…` : '❌ не задан'}`);
  lines.push(`VAPID приватный: ${privKey ? '✅ задан' : '❌ не задан'}`);
  lines.push('');

  if (!pubKey || !privKey) {
    lines.push('❌ Остановка: без VAPID ключей push физически невозможен.');
    lines.push('Добавь NEXT_PUBLIC_VAPID_KEY и VAPID_PRIVATE_KEY в Timeweb.');
    await reply(ownerChatId, lines.join('\n'));
    return;
  }

  // 2. Подписки в БД
  const { rows: subs } = await pool.query<{ id: string; created_at: string }>(
    `SELECT id, created_at FROM push_subscriptions ORDER BY created_at DESC LIMIT 5`
  );
  lines.push(`push_subscriptions: ${subs.length === 0 ? '❌ пусто (никто не подписан)' : `✅ ${subs.length} активных (последние 5)`}`);
  subs.forEach(s => lines.push(`  • ${s.id.slice(0, 8)}… создана ${new Date(s.created_at).toLocaleDateString('ru')}`));
  lines.push('');

  if (subs.length === 0) {
    lines.push('❌ Остановка: нет подписчиков. Открой vedarai.ru в браузере → разреши уведомления.');
    await reply(ownerChatId, lines.join('\n'));
    return;
  }

  // 3. Отправить реальный тест-push
  lines.push('Отправляю тест-push…');
  await reply(ownerChatId, lines.join('\n'));

  const { sendPushBroadcast } = await import('@/lib/notifications/web-push');
  const result = await sendPushBroadcast({
    title: 'Тест push-уведомления',
    body: 'Если видишь это — push работает.',
    url: '/safety',
    tag: `test-${Date.now()}`,
  });

  const summary = [
    '',
    '<b>Результат:</b>',
    `Подписок: ${result.total}`,
    `Доставлено: ${result.sent} ${result.sent > 0 ? '✅' : '❌'}`,
    `Ошибки: ${result.failed}`,
    `Удалено истёкших: ${result.removed}`,
    '',
    result.sent > 0
      ? '✅ Push работает. Посмотри на телефон — уведомление должно быть.'
      : `❌ Push не доставлен (sent=0, total=${result.total}). Проверь VAPID ключи и endpoint'ы.`,
  ].join('\n');

  await reply(ownerChatId, summary);
}

// ── Channel diagnostics ───────────────────────────────────────────────────────

async function checkChannels(ownerChatId: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { await reply(ownerChatId, 'TELEGRAM_BOT_TOKEN не задан'); return; }

  // Таймаут 8s + 2 попытки: без таймаута зависший getChat убивает всю функцию
  // до отправки результата (видно как "Проверяю..." без ответа).
  async function tgGetChat(chatId: string): Promise<{ ok: boolean; result?: { title: string; type: string }; description?: string }> {
    let lastErr = 'fetch error';
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/getChat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId }),
          signal: AbortSignal.timeout(8000),
        });
        return await res.json() as { ok: boolean; result?: { title: string; type: string }; description?: string };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : 'fetch error';
        if (i === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    return { ok: false, description: `${lastErr} (egress до Telegram недоступен)` };
  }

  const lines: string[] = ['<b>Проверка каналов:</b>', ''];

  const kamId = process.env.TELEGRAM_CHANNEL_ID?.trim();
  if (kamId) {
    const r = await tgGetChat(kamId);
    lines.push(`TELEGRAM_CHANNEL_ID: <code>${kamId}</code>`);
    lines.push(r.ok ? `✅ ${r.result?.title} (${r.result?.type})` : `❌ ${r.description}`);
  } else {
    lines.push('TELEGRAM_CHANNEL_ID: ❌ не задан');
  }

  lines.push('');

  const aiId = process.env.TELEGRAM_AI_CHANNEL_ID?.trim();
  if (aiId) {
    const r = await tgGetChat(aiId);
    lines.push(`TELEGRAM_AI_CHANNEL_ID: <code>${aiId}</code>`);
    lines.push(r.ok ? `✅ ${r.result?.title} (${r.result?.type})` : `❌ ${r.description}`);
  } else {
    lines.push('TELEGRAM_AI_CHANNEL_ID: ❌ не задан');
  }

  lines.push('', '<i>Если ❌ — добавь @kuzmichai_bot как admin в канал с правом "Публиковать сообщения"</i>');
  await reply(ownerChatId, lines.join('\n'));
}

// ── Channel test posts ────────────────────────────────────────────────────────

// Пост про агентную оркестрацию в @ai_hub_money (фото-диаграмма + caption + кнопки)
async function sendAgentsPost(ownerChatId: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { await reply(ownerChatId, 'TELEGRAM_BOT_TOKEN не задан'); return; }
  const channel = process.env.TELEGRAM_AI_CHANNEL_ID?.trim();
  if (!channel) { await reply(ownerChatId, 'TELEGRAM_AI_CHANNEL_ID не задан'); return; }

  // Публичный домен (не внутренний twc1.net) для URL картинки
  const base = (process.env.NEXT_PUBLIC_SITE_URL
    || (process.env.NEXT_PUBLIC_APP_URL && !/twc1\.net/i.test(process.env.NEXT_PUBLIC_APP_URL) ? process.env.NEXT_PUBLIC_APP_URL : null)
    || 'https://vedarai.ru').replace(/\/$/, '');
  const photoUrl = `${base}/images/social/agent-orchestration.png`;

  // caption ≤1024 символов (лимит Telegram sendPhoto)
  const caption = [
    '<b>20+ AI-агентов в одном проде: спорят, учатся, оркеструются</b>',
    '',
    'Большинство пишет один вызов LLM и зовёт это «агентом». У нас агенты работают командой. Четыре паттерна.',
    '',
    '<b>Состязательность:</b> лид разбирают трое — Bull (сигналы покупки), Bear (риски), Arbiter (взвешивает, даёт вероятность). Спор бьёт один промпт.',
    '',
    '<b>Общий мозг:</b> агенты пишут в общую память, утренний брифинг раздаёт всем. Scout находит пробел → issue → другой агент реализует.',
    '',
    '<b>Само-эволюция:</b> growth находит баг → evolution чинит → feedback выводит правило на будущее.',
    '',
    '<b>Оркестрация:</b> детерминированные пайплайны, guardrails: tsc+тесты, human-in-the-loop.',
    '',
    'Главный риск — не тупость, а уверенная выдумка. Деризкинг с нуля: факты безопасности только из БД, иначе честное «не знаю».',
  ].join('\n');

  const buttons = [
    [{ text: 'CLAUDE.md — конституция агентов', url: 'https://github.com/tourhabk-ui/pos/blob/main/CLAUDE.md' }],
    [{ text: 'Платформа на агентах', url: 'https://t.me/kamchatka_real' }],
  ];

  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channel,
        photo: photoUrl,
        caption: caption.slice(0, 1024),
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    await reply(ownerChatId, data.ok
      ? `Пост опубликован в @ai_hub_money\nКартинка: ${photoUrl}`
      : `Ошибка постинга: ${data.description ?? 'unknown'}\nURL картинки: ${photoUrl}`);
  } catch (e) {
    await reply(ownerChatId, `Сбой отправки: ${e instanceof Error ? e.message : 'fetch error'}`);
  }
}

async function sendChannelTests(ownerChatId: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { await reply(ownerChatId, 'TELEGRAM_BOT_TOKEN не задан'); return; }

  async function tgChannel(
    chatId: string,
    text: string,
    buttons?: Array<Array<{ text: string; url: string }>>,
  ): Promise<{ ok: boolean; description?: string }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 4096),
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    try {
      const res = await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      return await res.json() as { ok: boolean; description?: string };
    } catch (e) {
      return { ok: false, description: e instanceof Error ? e.message : 'fetch error' };
    }
  }

  const results: string[] = [];

  // @kamchatka_real — туристический канал
  const kamChannel = process.env.TELEGRAM_CHANNEL_ID?.trim();
  if (kamChannel) {
    const text = [
      '<b>Авачинский вулкан — открытие сезона</b>',
      '',
      'Снег на гребне сошёл. Маршрут на кратер открыт.',
      '',
      '<b>Параметры маршрута:</b>',
      '↗ Набор: 1 700 м  |  📍 8 км  |  ⏱ 6–8 часов',
      '',
      '<blockquote>Регистрация в МЧС обязательна.\nТелефон: 8-4152-41-84-85\nБез неё на маршрут не выпустим.</blockquote>',
      '',
      '<i>Есть вопросы — пишите Кузьмичу.</i>',
    ].join('\n');
    const r = await tgChannel(kamChannel, text, [
      [{ text: 'Маршруты на карте →', url: 'https://tourhab.ru/routes' }],
      [{ text: 'Спросить Кузьмича', url: 'https://t.me/KuzmichKam_bot' }],
    ]);
    results.push(`@kamchatka_real: ${r.ok ? 'OK' : (r.description ?? 'err')}`);
  } else {
    results.push('@kamchatka_real: TELEGRAM_CHANNEL_ID не задан');
  }

  // пауза между запросами (Timeweb иногда режет быстрые sequential fetch)
  await new Promise(r => setTimeout(r, 800));

  // @ai_hub_money — AI/вайб-кодинг канал
  const aiChannel = process.env.TELEGRAM_AI_CHANNEL_ID?.trim();
  if (aiChannel) {
    const text = [
      '<b>Claude Code — три фичи, которые меняют workflow</b>',
      '',
      '• <b>CLAUDE.md как конституция</b> — агент читает его перед каждой задачей. Описываешь архитектуру раз → не объясняешь каждый раз.',
      '',
      '• <b>Параллельные агенты</b> — один пишет API, другой UI. Оба коммитят в один PR через <code>worktree</code>-изоляцию.',
      '',
      '• <b>Issues как бэклог</b> — агент создаёт <code>agent-proposal</code> issues, следующий их читает и реализует. Цикл без PM.',
      '',
      '<blockquote expandable>Наш стек: Next.js 15 + Claude Code Action + GitHub Actions cron.\n\nScout-Innovator каждое утро анализирует кодовую базу и предлагает улучшения в GitHub Issues. Scout-Digest собирает RSS и постит сюда AI-инсайты. Всё работает без ручного запуска.</blockquote>',
    ].join('\n');
    const r = await tgChannel(aiChannel, text, [
      [{ text: 'CLAUDE.md пример →', url: 'https://github.com/tourhabk-ui/pos/blob/main/CLAUDE.md' }],
      [{ text: 'Туристическая платформа на Claude', url: 'https://t.me/kamchatka_real' }],
    ]);
    results.push(`@ai_hub_money: ${r.ok ? 'OK' : (r.description ?? 'err')}`);
  } else {
    results.push('@ai_hub_money: TELEGRAM_AI_CHANNEL_ID не задан');
  }

  await reply(ownerChatId, results.join('\n'));
}

// ── Сканирование TG-групп операторов ────────────────────────────────────────

async function scanOperators(chatId: number): Promise<void> {
  try {
    const result = await scanAllOperatorGroups(72);
    if (result.groups_scanned === 0) {
      await reply(chatId, 'Нет операторов с TG-группами в базе.\nЗапусти сначала: POST /api/admin/import/operators { "action": "scrape_operators" }');
      return;
    }
    if (result.total_signals === 0) {
      await reply(chatId, `Просканировано ${result.groups_scanned} групп — новых объявлений о местах не найдено.`);
      return;
    }
    const lines = result.results
      .filter(r => r.signals_found > 0)
      .map(r => {
        const top = r.signals.slice(0, 3).map(s => {
          const parts = [`• <b>${s.tour_type}</b>`];
          if (s.date) parts.push(s.date);
          if (s.price) parts.push(`${s.price.toLocaleString('ru-RU')} ₽`);
          if (s.slots_available) parts.push(`${s.slots_available} мест`);
          if (s.contact) parts.push(s.contact);
          return parts.join(' | ');
        });
        return `<b>${r.group}</b> (${r.signals_found} сигналов)\n${top.join('\n')}`;
      });
    await reply(chatId,
      `<b>Наличие мест у операторов</b>\n\n${lines.join('\n\n')}\n\n` +
      `Групп: ${result.groups_scanned} | Сигналов: ${result.total_signals}`
    );
  } catch (e) {
    await reply(chatId, `Ошибка сканирования: ${(e as Error).message}`);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleCommand(cmd: string, chatId: number): Promise<void> {
  switch (cmd) {
    case '/start':
    case '/help':
      await reply(chatId, [
        '<b>TourHab Admin</b>',
        '',
        '/health — AI + БД',
        '/stats — цифры платформы',
        '/leads — последние лиды',
        '/digest — анализ AI',
        '/agents — команда AI',
        '/kuzmich — пост маршрута',
        '/tip — совет Кузьмича',
        '/testpush — реальный push на телефон + диагностика VAPID/подписок',
        '/checkchannels — проверить доступность каналов (без постинга)',
        '/testchannels — тест-посты в оба канала',
        '/postagents — пост про агентную оркестрацию в @ai_hub_money (с картинкой)',
        '/scanops — сканировать TG-группы операторов → прислать сигналы о местах',
        '',
        'Любой текст — уходит в Команду AI и возвращается с ответом нужного агента',
      ].join('\n'));
      break;

    case '/health':
      await reply(chatId, 'Проверяю...');
      await reply(chatId, await checkHealth());
      break;

    case '/stats':
      await reply(chatId, '<b>Статистика</b>\n\n' + await getStats());
      break;

    case '/leads':
      await reply(chatId, '<b>Последние лиды</b>\n\n<code>' + await getLeads() + '</code>');
      break;

    case '/digest':
      await reply(chatId, 'Анализирую...');
      await reply(chatId, '<b>Дайджест Claude</b>\n\n' + await runDigest());
      break;

    case '/kuzmich':
      await reply(chatId, 'Публикую маршрут...');
      {
        const r = await postKuzmichRoute();
        await reply(chatId, r.ok ? `Опубликовано (${r.routeId ?? 'ok'})` : `Ошибка: ${r.error ?? 'unknown'}`);
      }
      break;

    case '/agents':
      await reply(chatId, [
        '<b>Команда AI</b>',
        '',
        'Просто пиши — нужный агент ответит автоматически.',
        '',
        'Примеры:',
        '"проверь договор с оператором" → Legal',
        '"аномалии в доступах" → Security',
        '"как поднять конверсию" → Hacker',
        '"погодные риски на маршрутах" → Rescue',
        '"нагрузка на природу" → Eco',
        '"аудит описаний туров" → Content',
        '"прогноз бронирований на лето" → Planning',
        '"отзывы с рейтингом ниже 3" → Quality',
        '"оптимизация платформы" → Evo',
        '"последние лиды" → Leads',
        '',
        'Не подошло — отвечает Admin AI с данными платформы.',
      ].join('\n'));
      break;

    case '/tip':
      await reply(chatId, 'Публикую совет...');
      {
        const r = await postKuzmichTip();
        await reply(chatId, r.ok ? 'Совет опубликован' : `Ошибка: ${r.error ?? 'unknown'}`);
      }
      break;

    case '/testpush':
      await testPush(chatId);
      break;

    case '/checkchannels':
      await reply(chatId, 'Проверяю...');
      await checkChannels(chatId);
      break;

    case '/scanops':
      await reply(chatId, 'Запускаю сканирование операторов...');
      await scanOperators(chatId);
      break;

    case '/testchannels':
      await reply(chatId, 'Отправляю тесты...');
      await sendChannelTests(chatId);
      break;

    case '/postagents':
      await reply(chatId, 'Публикую пост про агентов в @ai_hub_money...');
      await sendAgentsPost(chatId);
      break;

    default:
      await reply(chatId, `Неизвестная команда. /help`);
  }
}

// ── Agent name labels ─────────────────────────────────────────────────────────

const AGENT_LABELS: Record<string, string> = {
  admin: 'Admin',
  legal: 'Legal',
  sec: 'Security',
  hack: 'Hacker',
  rescue: 'Rescue',
  eco: 'Eco',
  evo: 'Evo',
  content: 'Content',
  mkt: 'Marketing',
  plan: 'Planning',
  qa: 'Quality',
  lead: 'Leads',
  op: 'Operator',
  tourist: 'Tourist',
  guide: 'Guide',
  transfer: 'Transfer',
};

function agentLabel(intent: string): string {
  const prefix = intent.split('_')[0] ?? '';
  return AGENT_LABELS[prefix] ? `[${AGENT_LABELS[prefix]}]` : '[AI]';
}

// ── Free text → PlatformAgent + conversation history ─────────────────────────

async function handleFreeText(text: string, chatId: number): Promise<void> {
  const ownerId = parseInt(process.env.TELEGRAM_OWNER_ID ?? '171286547', 10);

  await saveAdminMessage(chatId, 'user', text);

  try {
    const result = await PlatformAgent.dispatch({
      message: text,
      userId: ownerId,
      role: 'admin',
    });

    const label = agentLabel(result.intent);
    const header = result.intent !== 'unknown' ? `${label}\n\n` : '';
    const response = header + result.response;
    await saveAdminMessage(chatId, 'assistant', result.response);
    await reply(chatId, response);
  } catch {
    // fallback — AI ответ со статистикой и историей разговора
    const [stats, history] = await Promise.all([getStats(), getAdminHistory(chatId)]);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Ты AI-директор платформы TourHab (Камчатка). Отвечаешь владельцу кратко и по делу.\nДанные платформы:\n${stats}`,
      },
      ...history,
    ];
    const answer = await callAIWaterfall(messages);
    await saveAdminMessage(chatId, 'assistant', answer);
    await reply(chatId, answer);
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────────

interface TgUpdate {
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
}

// ── GET: Тестирование команд ─────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const ip = getClientIp(request.headers);
  if (!adminGetLimiter.check(ip)) {
    return NextResponse.json({ error: 'Слишком много запросов' }, { status: 429 });
  }

  try {
    const { searchParams } = request.nextUrl;
    const command = searchParams.get('command')?.toLowerCase() ?? '';
    const ownerId = parseInt(process.env.TELEGRAM_OWNER_ID ?? '171286547', 10);

    if (!command) {
      return NextResponse.json({
        error: 'Missing command parameter',
        available_commands: ['/health', '/stats', '/leads', '/digest', '/tip', '/testchannels'],
        example: '/api/telegram/admin?command=health'
      }, { status: 400 });
    }

    // Используем owner ID как chat ID для тестирования
    await handleCommand('/' + command, ownerId);

    return NextResponse.json({
      success: true,
      command,
      message_sent_to: ownerId,
      hint: 'Чек сообщение в твоём Telegram чате'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── POST: Webhook Telegram ───────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const update = await request.json() as TgUpdate;
    const msg = update.message;
    if (!msg?.text) return NextResponse.json({ ok: true });

    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    const ownerId = parseInt(process.env.TELEGRAM_OWNER_ID ?? '171286547', 10);

    if (fromId !== ownerId) {
      await reply(chatId, 'Доступ закрыт.');
      return NextResponse.json({ ok: true });
    }

    const text = msg.text.trim();
    const cmd = text.split(' ')[0]?.toLowerCase() ?? '';

    if (cmd.startsWith('/')) {
      await handleCommand(cmd, chatId);
    } else {
      await handleFreeText(text, chatId);
    }
  } catch { /* silent */ }

  return NextResponse.json({ ok: true });
}
