/*
 * AutoGram AI — backend сервер (24/7 автопостинг + легальная рассылка по пабликам + бесплатный AI)
 * Без внешних зависимостей. Требует Node.js >= 18 (встроенный fetch).
 * Запуск:  node server.js   (или  npm start)
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

let DB = {
  config: {
    token: process.env.BOT_TOKEN || "",
    channelId: process.env.CHANNEL_ID || "",
    topic: process.env.TOPIC || "",
    intervalMinutes: Number(process.env.INTERVAL_MINUTES) || 120,
    withImage: process.env.WITH_IMAGE === "true",
    aiProvider: process.env.AI_PROVIDER || "pollinations",
    aiKey: process.env.AI_KEY || "",
    aiBaseUrl: process.env.AI_BASE_URL || "",
    aiModel: process.env.AI_MODEL || "",
    targets: [] // паблики/группы для рассылки (куда бот добавлен)
  },
  me: null,
  running: process.env.AUTOSTART === "true",
  lastRun: 0,
  logs: []
};
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) {}
if (!Array.isArray(DB.config.targets)) DB.config.targets = [];

function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2)); } catch (e) {} }
function log(level, msg) {
  DB.logs.unshift({ t: new Date().toISOString(), level: level, msg: msg });
  if (DB.logs.length > 300) DB.logs.pop();
  save();
  console.log("[" + level + "] " + msg);
}

// Понятные подсказки по ошибкам Telegram
function hintError(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("unauthorized")) return "Неверный токен бота. Скопируйте токен заново у @BotFather (без пробелов).";
  if (m.includes("chat not found")) return "Канал не найден. Проверьте @username или ID (-100...) и что бот добавлен в канал.";
  if (m.includes("not a member") || m.includes("bot is not a member")) return "Бот не добавлен в этот канал/паблик. Добавьте его в админы.";
  if (m.includes("not enough rights") || m.includes("need administrator") || m.includes("administrator rights")) return "У бота нет прав на публикацию. В настройках админа включите «Публикация сообщений».";
  if (m.includes("forbidden")) return "Доступ запрещён: бот не админ канала или у него нет прав.";
  return String(msg || "Неизвестная ошибка");
}

// ---------- Telegram ----------
async function tg(method, params) {
  const token = DB.config.token;
  if (!token) throw new Error("Токен бота не задан. Вставьте его в настройках.");
  let res;
  try {
    res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {})
    });
  } catch (e) {
    throw new Error("Нет связи с Telegram (проверьте интернет/блокировки): " + e.message);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(hintError(data.description));
  return data.result;
}

// ---------- AI (бесплатный) ----------
function fallbackPost(topic) {
  const tag = String(topic).replace(/\s+/g, "");
  return "✨ " + topic + "\n\n" +
    "Сегодня — коротко и по делу о теме «" + topic + "».\n\n" +
    "🔹 Почему это важно: тема набирает популярность.\n" +
    "🔹 Что стоит знать: главное без воды.\n" +
    "🔹 Как применить: простые шаги уже сегодня.\n\n" +
    "🔔 Подписывайтесь, чтобы не пропустить новые посты!\n\n" +
    "#" + tag + " #интересное";
}

async function aiText(topic) {
  const prompt = "Напиши большой, интересный и полезный пост для Telegram-канала на тему \"" + topic + "\". На русском языке. Структура: цепляющий заголовок с эмодзи, вступление, 3-4 содержательных пункта с эмодзи, призыв подписаться и 3-5 хештегов. Без markdown-разметки, только текст и эмодзи. Объём 1500-2500 знаков.";
  const p = DB.config.aiProvider || "pollinations";
  try {
    if (p === "groq" || p === "openai") {
      const base = p === "groq" ? "https://api.groq.com/openai/v1" : (DB.config.aiBaseUrl || "https://api.groq.com/openai/v1");
      const model = DB.config.aiModel || (p === "groq" ? "llama-3.3-70b-versatile" : "gpt-3.5-turbo");
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + DB.config.aiKey },
        body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], temperature: 0.8 })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "AI error");
      return data.choices[0].message.content.trim();
    }
    const res = await fetch("https://text.pollinations.ai/" + encodeURIComponent(prompt));
    const txt = (await res.text()).trim();
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (txt.length < 40) throw new Error("пустой ответ");
    if (txt[0] === "{" && /\"error\"|deprecat|\"status\"\s*:\s*4/i.test(txt)) throw new Error("лимит/очередь API");
    return txt;
  } catch (e) {
    log("warn", "AI не сгенерировал текст (" + e.message + "), использую запасной шаблон");
    return fallbackPost(topic);
  }
}

function imageUrl(topic) {
  const prompt = "editorial illustration about " + topic + ", modern, clean, vibrant, telegram cover";
  return "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=1024&height=768&nologo=true&seed=" + Math.floor(Math.random() * 100000);
}

// Скачивает картинку сами (с таймаутом) и возвращает Buffer
async function fetchImageBuffer(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms || 50000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000) throw new Error("слишком маленький файл");
    return buf;
  } finally { clearTimeout(timer); }
}

// Отправляет фото ЗАГРУЗКОЙ файла (Telegram не качает URL сам — надёжнее)
async function sendPhotoUpload(chatId, buf, caption) {
  const token = DB.config.token;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("photo", new Blob([buf], { type: "image/jpeg" }), "post.jpg");
  let res;
  try { res = await fetch("https://api.telegram.org/bot" + token + "/sendPhoto", { method: "POST", body: form }); }
  catch (e) { throw new Error("Нет связи с Telegram: " + e.message); }
  const data = await res.json();
  if (!data.ok) throw new Error(hintError(data.description));
  return data.result;
}

async function publishPost() {
  const c = DB.config;
  if (!c.channelId) throw new Error("Не указан канал (channelId)");
  const topic = c.topic || "интересные факты";
  log("info", "Генерирую пост на тему: " + topic);
  const text = await aiText(topic);
  let imgOk = false;
  if (c.withImage) {
    try {
      log("info", "Генерирую картинку…");
      const buf = await fetchImageBuffer(imageUrl(topic), 50000);
      const caption = text.length <= 1024 ? text : "";
      await sendPhotoUpload(c.channelId, buf, caption);
      if (!caption) await tg("sendMessage", { chat_id: c.channelId, text: text });
      imgOk = true;
    } catch (e) {
      log("warn", "Картинку отправить не удалось (" + e.message + "), публикую без неё");
    }
  }
  if (!imgOk) {
    await tg("sendMessage", { chat_id: c.channelId, text: text });
  }
  log("ok", "✅ Пост опубликован в канал");
}

// ---------- Легальная рассылка по пабликам (куда бот добавлен) ----------
function normId(input) {
  input = String(input || "").trim();
  if (/^-?\d+$/.test(input)) return Number(input);
  return input[0] === "@" ? input : "@" + input;
}

async function addTarget(input) {
  const chatId = normId(input);
  if (!chatId) throw new Error("Укажите @username или ID паблика");
  const chat = await tg("getChat", { chat_id: chatId });
  const exists = DB.config.targets.find(function (t) { return String(t.chatId) === String(chatId); });
  if (exists) throw new Error("Этот паблик уже добавлен");
  DB.config.targets.push({ chatId: chatId, title: chat.title || chat.username || String(chatId), username: chat.username || "" });
  save(); log("ok", "Добавлен паблик для рассылки: " + (chat.title || chatId));
  return DB.config.targets;
}

// Рассылает промо с пригласительной ссылкой во все добавленные паблики
async function broadcast(promoText) {
  const c = DB.config;
  if (!c.channelId) throw new Error("Сначала укажите свой основной канал");
  if (!c.targets.length) throw new Error("Нет пабликов для рассылки. Добавьте те, куда бот добавлен.");
  let link;
  try { link = (await tg("createChatInviteLink", { chat_id: c.channelId, name: "broadcast " + new Date().toISOString().slice(0, 16) })).invite_link; }
  catch (e) { link = c.channelId && String(c.channelId)[0] === "@" ? "https://t.me/" + String(c.channelId).slice(1) : ""; }
  const text = (promoText && promoText.trim() ? promoText.trim() : "🔥 Подписывайтесь на наш канал — много полезного!") + (link ? "\n\n👉 " + link : "");
  const results = [];
  for (const t of c.targets) {
    try { await tg("sendMessage", { chat_id: t.chatId, text: text }); results.push({ title: t.title, ok: true }); log("ok", "Рассылка → «" + t.title + "» ✓"); }
    catch (e) { results.push({ title: t.title, ok: false, error: e.message }); log("error", "Рассылка → «" + t.title + "»: " + e.message); }
  }
  return { link: link, results: results };
}

// ---------- Планировщик (24/7) ----------
setInterval(async function () {
  if (!DB.running) return;
  if (Date.now() - (DB.lastRun || 0) < DB.config.intervalMinutes * 60000) return;
  DB.lastRun = Date.now(); save();
  try { await publishPost(); } catch (e) { log("error", "Автопостинг: " + e.message); }
}, 20000);

// ---------- HTTP API + панель ----------
function sendJSON(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(function (resolve) { let b = ""; req.on("data", function (c) { b += c; }); req.on("end", function () { try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve({}); } }); }); }

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && u.pathname === "/") {
      const html = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (u.pathname === "/api/state") {
      return sendJSON(res, 200, { config: DB.config, me: DB.me, running: DB.running, lastRun: DB.lastRun, logs: DB.logs.slice(0, 60) });
    }
    if (req.method === "POST" && u.pathname === "/api/save") {
      const b = await readBody(req);
      ["token", "channelId", "topic", "intervalMinutes", "withImage", "aiProvider", "aiKey", "aiBaseUrl", "aiModel"].forEach(function (k) {
        if (b[k] !== undefined) DB.config[k] = b[k];
      });
      DB.config.intervalMinutes = Math.max(1, Number(DB.config.intervalMinutes) || 120);
      save(); log("info", "Настройки сохранены");
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/test") {
      const me = await tg("getMe"); DB.me = me; save(); log("ok", "Бот подключён: @" + me.username);
      let chat = null, subs = null;
      if (DB.config.channelId) { chat = await tg("getChat", { chat_id: DB.config.channelId }); subs = await tg("getChatMemberCount", { chat_id: DB.config.channelId }); }
      return sendJSON(res, 200, { ok: true, me: me, chat: chat, subs: subs });
    }
    if (req.method === "POST" && u.pathname === "/api/post-now") { await publishPost(); return sendJSON(res, 200, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/start") { DB.running = true; DB.lastRun = 0; save(); log("ok", "▶ Автопостинг запущен"); return sendJSON(res, 200, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/stop") { DB.running = false; save(); log("info", "⏹ Автопостинг остановлен"); return sendJSON(res, 200, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/target-add") { const b = await readBody(req); const targets = await addTarget(b.input); return sendJSON(res, 200, { ok: true, targets: targets }); }
    if (req.method === "POST" && u.pathname === "/api/target-remove") { const b = await readBody(req); DB.config.targets = DB.config.targets.filter(function (t) { return String(t.chatId) !== String(b.chatId); }); save(); return sendJSON(res, 200, { ok: true, targets: DB.config.targets }); }
    if (req.method === "POST" && u.pathname === "/api/broadcast") { const b = await readBody(req); const r = await broadcast(b.promoText); return sendJSON(res, 200, { ok: true, result: r }); }
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
  } catch (e) {
    log("error", u.pathname + ": " + e.message);
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, function () {
  console.log("AutoGram AI server → http://localhost:" + PORT);
  log("info", "Сервер запущен на порту " + PORT);
  if (DB.config.token) {
    tg("getMe").then(function (m) { DB.me = m; save(); log("ok", "Бот подключён: @" + m.username); }).catch(function (e) { log("error", "getMe: " + e.message); });
  }
});
