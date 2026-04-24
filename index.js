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
// HEALTH (KEEP RENDER AWAKE)
// ----------------------

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ----------------------
// TELEGRAM SENDER (RETRY SAFE)
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
// WEBHOOK (FAST QUEUE)
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
// CLAIM BATCH
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
// WORKER
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

📡 I track channel:
• Joins
• Leaves
• Member changes

━━━━━━━━━━━━━━
🔧 Setup:
1. Add me as ADMIN in your channel
2. Give "View Members" permission
3. Use /channels

━━━━━━━━━━━━━━
📌 Commands:
/channels - view channels
/help - help menu
/unsubscribe <id> - stop tracking`
    );
  }

  // ----------------------
  // HELP
  // ----------------------
  if (msg === "/help") {
    return sendMessage(
      user.id,
`📘 <b>Help</b>

/channels → list channels
/unsubscribe <id> → stop tracking
/start → setup bot

⚙️ The bot tracks joins/leaves in real time.`
    );
  }

  // ----------------------
  // CHANNELS (FIXED LINKING)
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
      ? `<a href="${link}">${ch.title}</a>`
      : `<b>${ch?.title || "Unknown"}</b>`;

    out += `• ${display}\n<code>${c.channel_id}</code>\n\n`;
  }

  return sendMessage(user.id, out);
}

  // ----------------------
  // UNSUBSCRIBE (YOUR REQUEST FIXED)
  // ----------------------
  if (msg?.startsWith("/unsubscribe")) {
  const parts = msg.split(" ");
  const channelId = parts[1];

  if (!channelId) {
    return sendMessage(
      user.id,
      "❌ Usage: /unsubscribe <channel_id>"
    );
  }

  // 🔥 fetch channel first for nice UX
  const { data: ch } = await supabase
    .from("channels")
    .select("title, username")
    .eq("id", channelId)
    .single();

  const channelLink = ch?.username
    ? `<a href="https://t.me/${ch.username}">${ch.title}</a>`
    : `<b>${ch?.title || "Channel"}</b>`;

  // 🔥 REMOVE subscription (no active column needed)
  await supabase
    .from("channel_admins")
    .delete()
    .eq("user_id", user.id)
    .eq("channel_id", channelId);

  return sendMessage(
    user.id,
`🛑 Unsubscribed from ${channelLink}

You will no longer receive updates from this channel.`
  );
}

  // ----------------------
  // BOT ADDED TO CHANNEL
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
        `✅ Tracking started for <b>${chat.title}</b>`
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

  // 🔥 FIXED: ALWAYS LINK CHANNEL IF POSSIBLE
  const channelLink = channel.username
    ? `<a href="https://t.me/${channel.username}">${channel.title}</a>`
    : `<b>${channel.title}</b>`;

  const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

📢 ${channelLink} - ${channel.id}
👤 ${username}
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

  // DB log (safe, non-blocking)
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
  log("🚀 Fully upgraded tracker running");
});