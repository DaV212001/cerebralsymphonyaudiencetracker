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
// HEALTH ENDPOINT (WAKE RENDER)
// ----------------------

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    status: "alive",
    time: new Date().toISOString(),
  });
});

// ----------------------
// TELEGRAM SENDER
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
      const delay = 1000 * 2 ** retry;
      return setTimeout(
        () => sendMessage(chatId, text, retry + 1),
        delay
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
// WEBHOOK (FAST)
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
  try {
    const msg = update.message?.text;
    const user = update.message?.from;

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

This bot tracks:
📊 Channel joins
📊 Channel leaves
📊 Audience changes in real time

━━━━━━━━━━━━━━
🔧 How to use:

1️⃣ Add this bot as ADMIN in your channel
2️⃣ Give it permission to "View Members"
3️⃣ Use /channels to verify connection

━━━━━━━━━━━━━━
📌 Commands:
/channels - view your connected channels
/help - full command list

⚡ The bot works in real-time and logs all changes securely.`
      );
    }

    // ----------------------
    // HELP
    // ----------------------
    if (msg === "/help") {
      return sendMessage(
        user.id,
`📘 <b>Help Menu</b>

/start - initialize bot
/channels - show connected channels
/help - show this message

━━━━━━━━━━━━━━
📡 Features:
• Tracks joins/leaves in channels
• Sends real-time notifications
• Stores history safely in database
• Retries failed events automatically`
      );
    }

    // ----------------------
    // CHANNELS
    // ----------------------
    if (msg === "/channels") {
      const { data } = await supabase
        .from("channel_admins")
        .select("channel_id, channels(title,username)")
        .eq("user_id", user.id);

      if (!data?.length) {
        return sendMessage(
          user.id,
          "📭 No channels connected yet.\n\nAdd me as admin first."
        );
      }

      let out = "📺 <b>Your Channels</b>\n\n";

      for (const c of data) {
        const ch = c.channels;

        const link = ch?.username
          ? `https://t.me/${ch.username}`
          : null;

        const display = link
          ? `<a href="${link}">${ch.title}</a>`
          : ch?.title || "Unknown";

        out += `• ${display}\n`;
      }

      return sendMessage(user.id, out);
    }

    // ----------------------
    // BOT ADDED TO CHANNEL
    // ----------------------
    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      const user = update.my_chat_member.from;

      if (chat.type === "channel") {
        await supabase.from("channels").upsert({
          id: chat.id,
          title: chat.title,
          username: chat.username || null,
        });

        await supabase.from("channel_admins").upsert({
          user_id: user.id,
          channel_id: chat.id,
        });

        return sendMessage(
          user.id,
          `✅ Connected to <b>${chat.title}</b>`
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
    const user2 = cm.new_chat_member.user;

    const time = safeTime(cm);

    const username = user2.username
      ? `@${user2.username}`
      : user2.first_name;

    const profile = user2.username
      ? `https://t.me/${user2.username}`
      : `tg://user?id=${user2.id}`;

    // IMPORTANT FIX: proper channel link
    const channelLink = channel.username
      ? `<a href="https://t.me/${channel.username}">${channel.title}</a>`
      : `<b>${channel.title}</b>`;

    const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

📢 ${channelLink}
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

    // DB log (non-blocking)
    supabase.from("events").insert({
      channel_id: channel.id,
      user_id: user2.id,
      username,
      event_type: isJoin ? "JOIN" : "LEAVE",
      event_time: time.toISOString(),
    });

    log("event:", isJoin ? "JOIN" : "LEAVE", username);
  } catch (e) {
    err("handler:", e.message);
  }
}

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Bot running with help + health + stable links");
});