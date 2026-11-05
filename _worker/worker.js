/**
 * «Бджілка» — відгуки з модерацією через Telegram.
 * Cloudflare Worker + KV.
 *
 * Прив'язки (Settings → Bindings / Variables):
 *   KV namespace:  REVIEWS
 *   Secret:        BOT_TOKEN       — токен бота від @BotFather
 *   Secret:        SETUP_CODE      — будь-яке слово-пароль для налаштування
 *   Secret:        WEBHOOK_SECRET  — будь-який довгий випадковий рядок (латиниця/цифри)
 *
 * Маршрути:
 *   GET  /reviews              — схвалені відгуки (JSON) для сайту
 *   POST /reviews              — новий відгук з форми сайту
 *   POST /telegram             — вебхук Telegram (кнопки модерації)
 *   GET  /setup?code=SETUP_CODE — один раз: підключає вебхук бота
 */

const ALLOWED_ORIGINS = [
  'https://bee.kyiv.ua',
  'https://www.bee.kyiv.ua',
  'http://bee.kyiv.ua',
  'https://rodionshkurko1994-dev.github.io',
];

const MAX_NAME = 60;
const MIN_TEXT = 10;
const MAX_TEXT = 1200;
const PER_IP_PER_HOUR = 3;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/reviews' && req.method === 'GET') return listReviews(env, cors);
      if (url.pathname === '/reviews' && req.method === 'POST') return submitReview(req, env, cors);
      if (url.pathname === '/telegram' && req.method === 'POST') return telegramHook(req, env);
      if (url.pathname === '/setup' && req.method === 'GET') return setup(url, env);
      if (url.pathname === '/') return text('Бджілка: сервіс відгуків працює 🐝');
      return text('Не знайдено', 404);
    } catch (e) {
      return json({ ok: false, error: 'Помилка сервера' }, 500, cors);
    }
  },
};

/* ---------- Сайт ---------- */

async function listReviews(env, cors) {
  const list = (await env.REVIEWS.get('approved', 'json')) || [];
  const pub = list.map(({ id, name, rating, text, date }) => ({ id, name, rating, text, date }));
  return json({ ok: true, reviews: pub }, 200, { ...cors, 'Cache-Control': 'public, max-age=60' });
}

async function submitReview(req, env, cors) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Некоректні дані' }, 400, cors); }

  // Пастка для ботів: приховане поле має лишатися порожнім
  if (body.website) return json({ ok: true }, 200, cors);

  const name = clean(body.name).slice(0, MAX_NAME);
  const textv = clean(body.text, true);
  const rating = Number(body.rating);

  if (name.length < 2) return json({ ok: false, error: 'Вкажіть, будь ласка, ім\'я' }, 400, cors);
  if (!(rating >= 1 && rating <= 5 && Number.isInteger(rating))) return json({ ok: false, error: 'Оберіть оцінку від 1 до 5' }, 400, cors);
  if (textv.length < MIN_TEXT) return json({ ok: false, error: 'Відгук закороткий: напишіть хоча б кілька слів' }, 400, cors);
  if (textv.length > MAX_TEXT) return json({ ok: false, error: `Відгук задовгий: до ${MAX_TEXT} символів` }, 400, cors);

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:${ip}`;
  const count = Number((await env.REVIEWS.get(rlKey)) || 0);
  if (count >= PER_IP_PER_HOUR) return json({ ok: false, error: 'Забагато відгуків поспіль. Спробуйте пізніше' }, 429, cors);
  await env.REVIEWS.put(rlKey, String(count + 1), { expirationTtl: 3600 });

  const owner = await env.REVIEWS.get('owner_chat_id');
  if (!owner) return json({ ok: false, error: 'Відгуки тимчасово не приймаються' }, 503, cors);

  const id = crypto.randomUUID().slice(0, 12);
  const review = { id, name, rating, text: textv, date: new Date().toISOString().slice(0, 10) };
  await env.REVIEWS.put(`pending:${id}`, JSON.stringify(review), { expirationTtl: 60 * 60 * 24 * 60 });

  await tg(env, 'sendMessage', {
    chat_id: owner,
    parse_mode: 'HTML',
    text: reviewCard(review, '🆕 <b>Новий відгук на сайті</b>'),
    reply_markup: { inline_keyboard: [[
      { text: '✅ Опублікувати', callback_data: `ok:${id}` },
      { text: '❌ Відхилити', callback_data: `no:${id}` },
    ]] },
  });

  return json({ ok: true }, 200, cors);
}

/* ---------- Telegram ---------- */

async function telegramHook(req, env) {
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return text('forbidden', 403);
  const upd = await req.json();
  const owner = await env.REVIEWS.get('owner_chat_id');

  // Прив'язка власниці: /start КОД
  if (upd.message?.text) {
    const chatId = String(upd.message.chat.id);
    const [cmd, arg] = upd.message.text.trim().split(/\s+/);
    if (cmd === '/start' || cmd === '/owner') {
      if (arg && arg === env.SETUP_CODE) {
        await env.REVIEWS.put('owner_chat_id', chatId);
        await tg(env, 'sendMessage', { chat_id: chatId, text: '🐝 Готово! Тепер нові відгуки з сайту приходитимуть сюди на модерацію.\n\n/list — опубліковані відгуки' });
      } else if (chatId !== owner) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'Це службовий бот садочка «Бджілка». Залишити відгук можна на сайті bee.kyiv.ua 🐝' });
      } else {
        await tg(env, 'sendMessage', { chat_id: chatId, text: '🐝 Нові відгуки приходитимуть сюди.\n/list — опубліковані відгуки' });
      }
      return text('ok');
    }
    if (cmd === '/list' && chatId === owner) {
      const list = (await env.REVIEWS.get('approved', 'json')) || [];
      if (!list.length) await tg(env, 'sendMessage', { chat_id: chatId, text: 'Опублікованих відгуків поки немає.' });
      for (const r of list.slice(-20)) {
        await tg(env, 'sendMessage', {
          chat_id: chatId, parse_mode: 'HTML', text: reviewCard(r, '✅ <b>На сайті</b>'),
          reply_markup: { inline_keyboard: [[{ text: '🗑 Прибрати з сайту', callback_data: `del:${r.id}` }]] },
        });
      }
      return text('ok');
    }
    return text('ok');
  }

  const cq = upd.callback_query;
  if (!cq) return text('ok');
  const from = String(cq.message?.chat?.id || '');
  if (!owner || from !== owner) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Немає доступу' });
    return text('ok');
  }

  const [action, id] = String(cq.data || '').split(':');
  let note = '', header = '', keyboard = [];

  if (action === 'ok' || action === 'no') {
    const raw = await env.REVIEWS.get(`pending:${id}`);
    if (!raw) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Цей відгук уже оброблено' });
      return text('ok');
    }
    const review = JSON.parse(raw);
    await env.REVIEWS.delete(`pending:${id}`);
    if (action === 'ok') {
      const list = (await env.REVIEWS.get('approved', 'json')) || [];
      list.push(review);
      await env.REVIEWS.put('approved', JSON.stringify(list));
      note = 'Опубліковано на сайті';
      header = '✅ <b>Опубліковано</b>';
      keyboard = [[{ text: '🗑 Прибрати з сайту', callback_data: `del:${id}` }]];
    } else {
      note = 'Відхилено';
      header = '❌ <b>Відхилено</b>';
    }
    await editCard(env, cq, reviewCard(review, header), keyboard);
  } else if (action === 'del') {
    const list = (await env.REVIEWS.get('approved', 'json')) || [];
    const review = list.find(r => r.id === id);
    await env.REVIEWS.put('approved', JSON.stringify(list.filter(r => r.id !== id)));
    note = 'Прибрано з сайту';
    if (review) await editCard(env, cq, reviewCard(review, '🗑 <b>Прибрано з сайту</b>'), []);
  }

  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: note || 'Готово' });
  return text('ok');
}

async function setup(url, env) {
  if (!env.SETUP_CODE || url.searchParams.get('code') !== env.SETUP_CODE) return text('Невірний код', 403);
  const hook = `${url.origin}/telegram`;
  const r = await tg(env, 'setWebhook', {
    url: hook,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  const me = await tg(env, 'getMe', {});
  const ok = r.ok && me.ok;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <body style="font-family:system-ui,sans-serif;padding:24px;max-width:560px;line-height:1.5">
     <h2>${ok ? '🐝 Бот підключено' : '⚠️ Не вдалося підключити бота'}</h2>
     ${ok
        ? `<p>Тепер власниця має відкрити бота <b>@${esc(me.result.username)}</b> у Telegram і надіслати йому повідомлення:</p>
           <pre style="background:#f4f0e6;padding:12px;border-radius:8px;font-size:16px">/start ${esc(env.SETUP_CODE)}</pre>
           <p>Після цього відгуки з сайту почнуть приходити їй на модерацію.</p>`
        : `<p>Перевірте BOT_TOKEN і WEBHOOK_SECRET. Відповідь Telegram:</p><pre>${esc(JSON.stringify(r))}</pre>`}
     </body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/* ---------- Допоміжне ---------- */

function reviewCard(r, header) {
  const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
  return `${header}\n\n<b>${esc(r.name)}</b>  ${stars}\n\n${esc(r.text)}\n\n<i>${r.date}</i>`;
}

async function editCard(env, cq, html, keyboard) {
  await tg(env, 'editMessageText', {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    parse_mode: 'HTML',
    text: html,
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

function clean(v, multiline = false) {
  let s = String(v ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allow ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function text(s, status = 200) {
  return new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
