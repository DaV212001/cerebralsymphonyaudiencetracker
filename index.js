require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ----------------------
// CONFIG
// ----------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ----------------------
// LOGGING
// ----------------------

const log = (...a) => console.log(new Date().toISOString(), ...a);
const err = (...a) => console.error(new Date().toISOString(), "❌", ...a);

// ----------------------
// HTML ESCAPER (CRITICAL FIX)
// ----------------------

function escapeHtml(text = "") {
  return text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ----------------------
// HEALTH ENDPOINT (Render wake-up)
// ----------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "alive",
    time: new Date().toISOString(),
  });
});

// ----------------------
// SAFE TELEGRAM SENDER
// ----------------------

async function sendMessage(chatId, text, retry = 0) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    const desc = e.response?.data?.description || "";

    // fallback if HTML breaks
    if (desc.includes("can't parse entities")) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: text.replace(/<[^>]*>/g, ""),
      });
      return;
    }

    if (retry < 4) {
      return setTimeout(
        () => sendMessage(chatId, text, retry + 1),
        1000 * Math.pow(2, retry)
      );
    }

    err("Telegram send failed:", e.response?.data || e.message);
  }
}

// ----------------------
// SAFE TIME
// ----------------------

function safeTime(cm) {
  const t = cm?.date;
  if (!t) return new Date();
  return new Date(t * 1000);
}

// ----------------------
// WEBHOOK (FAST QUEUE ONLY)
// ----------------------

app.post("/webhook", async (req, res) => {
  const update = req.body;
  res.sendStatus(200);

  if (!update?.update_id) return;

  try {
    await supabase.from("event_queue").insert({
      update_id: update.update_id,
      payload: update,
      status: "pending",
      retry_count: 0,
      next_retry_at: new Date().toISOString(),
    });
  } catch (e) {
    if (e?.code !== "23505") {
      err("Queue error:", e.message);
    }
  }
});

// ----------------------
// CLAIM BATCH (SAFE LOCKING)
// ----------------------

async function claimBatch() {
  const { data } = await supabase
    .from("event_queue")
    .select("*")
    .eq("status", "pending")
    .lte("next_retry_at", new Date().toISOString())
    .limit(10);

  if (!data?.length) return [];

  await supabase
    .from("event_queue")
    .update({
      status: "processing",
      locked_at: new Date().toISOString(),
    })
    .in("id", data.map((d) => d.id));

  return data;
}

// ----------------------
// WORKER LOOP
// ----------------------

let running = false;

async function worker() {
  if (running) return;
  running = true;

  try {
    const items = await claimBatch();

    if (!items.length) {
      running = false;
      return setTimeout(worker, 1200);
    }

    for (const item of items) {
      try {
        await handleUpdate(item.payload);

        await supabase
          .from("event_queue")
          .update({ status: "done" })
          .eq("id", item.id);

      } catch (e) {
        const retry = (item.retry_count || 0) + 1;

        await supabase
          .from("event_queue")
          .update({
            status: retry >= 5 ? "dead" : "pending",
            retry_count: retry,
            next_retry_at: new Date(
              Date.now() + Math.min(60000 * retry, 900000)
            ).toISOString(),
          })
          .eq("id", item.id);

        err("retry:", item.update_id, retry);
      }
    }
  } catch (e) {
    err("worker crash:", e.message);
  }

  running = false;
  setTimeout(worker, 800);
}

worker();

// ----------------------
// MAIN HANDLER
// ----------------------

async function handleUpdate(update) {
  const msg = update.message?.text;
  const user = update.message?.from;

  if (!user) return;

  // ----------------------
  // START
  // ----------------------
  if (msg === "/start") {
    await supabase.from("users").upsert({
      id: user.id,
      username: user.username || user.first_name,
    });

    return sendMessage(
      user.id,
`👋 <b>Welcome to Cerebral Symphony Tracker</b>

📡 Tracks:
• Channel joins
• Channel leaves
• Member changes

━━━━━━━━━━━━━━
🔧 Setup:
1. Add bot as ADMIN in channel
2. Enable "View Members"
3. Use /channels

━━━━━━━━━━━━━━
📌 Commands:
/channels
/help
/unsubscribe <id>`
    );
  }

  // ----------------------
  // HELP (FIXED SAFE HTML)
  // ----------------------
  if (msg === "/help") {
    return sendMessage(
      user.id,
`📘 <b>Help</b>

/channels → list channels
/unsubscribe &lt;id&gt; → stop tracking
/start → setup bot

⚙️ Real-time tracking of joins/leaves`
    );
  }

  // ----------------------
  // CHANNELS
  // ----------------------
  if (msg === "/channels") {
    const { data } = await supabase
      .from("channel_admins")
      .select("channel_id, channels(title, username)")
      .eq("user_id", user.id);

    if (!data?.length) {
      return sendMessage(user.id, "📭 No channels connected.");
    }

    let out = "📺 <b>Your Channels</b>\n\n";

    for (const c of data) {
      const ch = c.channels;

      const link = ch?.username
        ? `https://t.me/${ch.username}`
        : null;

      const display = link
        ? `<a href="${link}">${escapeHtml(ch.title)}</a>`
        : `<b>${escapeHtml(ch?.title || "Unknown")}</b>`;

      out += `• ${display}\n<code>${c.channel_id}</code>\n\n`;
    }

    return sendMessage(user.id, out);
  }

  // ----------------------
  // UNSUBSCRIBE (FIXED + LINKED)
  // ----------------------
  if (msg?.startsWith("/unsubscribe")) {
    const channelId = msg.split(" ")[1];

    if (!channelId) {
      return sendMessage(user.id, "❌ Usage: /unsubscribe <channel_id>");
    }

    const { data: ch } = await supabase
      .from("channels")
      .select("title, username")
      .eq("id", channelId)
      .single();

    const channelLink = ch?.username
      ? `<a href="https://t.me/${ch.username}">${escapeHtml(ch.title)}</a>`
      : `<b>${escapeHtml(ch?.title || "Channel")}</b>`;

    await supabase
      .from("channel_admins")
      .delete()
      .eq("user_id", user.id)
      .eq("channel_id", channelId);

    return sendMessage(
      user.id,
`🛑 Unsubscribed from ${channelLink}

You will no longer receive updates.`
    );
  }

  // ----------------------
  // BOT ADDED
  // ----------------------
  if (update.my_chat_member) {
    const chat = update.my_chat_member.chat;
    const admin = update.my_chat_member.from;

    if (chat.type === "channel") {
      await supabase.from("channels").upsert({
        id: chat.id,
        title: chat.title,
        username: chat.username || null,
      });

      await supabase.from("channel_admins").upsert({
        user_id: admin.id,
        channel_id: chat.id,
      });

      return sendMessage(
        admin.id,
        `✅ Tracking started: <b>${escapeHtml(chat.title)}</b>`
      );
    }
  }

  // ----------------------
  // JOIN / LEAVE
  // ----------------------
  const cm = update.chat_member;
  if (!cm) return;

  const oldS = cm.old_chat_member.status;
  const newS = cm.new_chat_member.status;

  const isJoin =
    ["left", "kicked"].includes(oldS) &&
    ["member", "administrator"].includes(newS);

  const isLeave =
    ["member", "administrator"].includes(oldS) &&
    ["left", "kicked"].includes(newS);

  if (!isJoin && !isLeave) return;

  const channel = cm.chat;
  const u = cm.new_chat_member.user;

  const time = safeTime(cm);

  const username = u.username
    ? `@${u.username}`
    : u.first_name;

  const profile = u.username
    ? `https://t.me/${u.username}`
    : `tg://user?id=${u.id}`;

  const channelLink = channel.username
    ? `<a href="https://t.me/${channel.username}">${escapeHtml(channel.title)}</a>`
    : `<b>${escapeHtml(channel.title)}</b>`;

  const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

📢 ${channelLink}
👤 ${escapeHtml(username)}
🔗 <a href="${profile}">Profile</a>

⏰ ${time.toLocaleString()}
`;

  const { data: admins } = await supabase
    .from("channel_admins")
    .select("user_id")
    .eq("channel_id", channel.id);

  for (const a of admins || []) {
    sendMessage(a.user_id, message);
  }

  supabase.from("events").insert({
    channel_id: channel.id,
    user_id: u.id,
    username,
    event_type: isJoin ? "JOIN" : "LEAVE",
    event_time: time.toISOString(),
  });

  log("event:", isJoin ? "JOIN" : "LEAVE", username);
}

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Fully stable tracker running");
});