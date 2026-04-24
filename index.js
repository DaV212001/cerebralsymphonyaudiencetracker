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
// SAFE TIME PARSER
// ----------------------

function safeEventTime(cm) {
  const raw = cm?.date;

  if (!raw) return new Date();

  if (raw > 1e12) return new Date(raw);
  if (raw < 1e12) return new Date(raw * 1000);

  return new Date();
}

// ----------------------
// TELEGRAM SEND (RETRY SAFE)
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
    if (retry < 5) {
      const delay = 1000 * Math.pow(2, retry); // exponential backoff
      return setTimeout(
        () => sendMessage(chatId, text, retry + 1),
        delay
      );
    }

    err("Telegram send failed permanently:", e.response?.data || e.message);
  }
}

// ----------------------
// WEBHOOK (ONLY QUEUE)
// ----------------------

app.post("/webhook", async (req, res) => {
  const update = req.body;

  // ALWAYS ACK FAST
  res.sendStatus(200);

  try {
    if (!update?.update_id) return;

    const { error } = await supabase.from("event_queue").insert({
      update_id: update.update_id,
      payload: update,
      status: "pending",
      retry_count: 0,
      next_retry_at: new Date().toISOString(),
    });

    if (error && error.code !== "23505") {
      err("Queue insert failed:", error.message);
    } else {
      log("📥 Queued:", update.update_id);
    }
  } catch (e) {
    err("Webhook crash:", e.message);
  }
});

// ----------------------
// WORKER LOCKING SYSTEM
// ----------------------

let running = false;

async function claimBatch() {
  const { data } = await supabase
    .from("event_queue")
    .select("*")
    .eq("status", "pending")
    .lte("next_retry_at", new Date().toISOString())
    .limit(10);

  if (!data?.length) return [];

  const ids = data.map((i) => i.id);

  await supabase
    .from("event_queue")
    .update({
      status: "processing",
      locked_at: new Date().toISOString(),
    })
    .in("id", ids);

  return data;
}

// ----------------------
// WORKER LOOP
// ----------------------

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
          .update({
            status: "done",
          })
          .eq("id", item.id);

        log("✅ Done:", item.update_id);
      } catch (e) {
        const retry = (item.retry_count || 0) + 1;

        const nextRetry =
          Date.now() + Math.min(60000 * retry, 15 * 60 * 1000);

        await supabase
          .from("event_queue")
          .update({
            status: retry >= 5 ? "dead" : "pending",
            retry_count: retry,
            next_retry_at: new Date(nextRetry).toISOString(),
          })
          .eq("id", item.id);

        err("❌ Retry scheduled:", item.update_id, "attempt", retry);
      }
    }
  } catch (e) {
    err("Worker crash:", e.message);
  }

  running = false;
  setTimeout(worker, 800);
}

worker();

// ----------------------
// MAIN HANDLER
// ----------------------

async function handleUpdate(update) {
  // ----------------------
  // COMMANDS
  // ----------------------

  if (update.message?.text === "/start") {
    const user = update.message.from;

    await supabase.from("users").upsert({
      id: user.id,
      username: user.username || user.first_name,
    });

    return sendMessage(
      user.id,
      `👋 <b>Bot Active</b>\n\nTracking events reliably.`
    );
  }

  if (update.message?.text === "/channels") {
    const userId = update.message.from.id;

    const { data } = await supabase
      .from("channel_admins")
      .select("channels(title,id,username)")
      .eq("user_id", userId);

    if (!data?.length) {
      return sendMessage(userId, "📭 No channels connected.");
    }

    let msg = "📺 <b>Your Channels</b>\n\n";

    for (const c of data) {
      const link = c.channels?.username
        ? `https://t.me/${c.channels.username}`
        : null;

      msg += `• ${link ? `<a href="${link}">${c.channels.title}</a>` : c.channels.title}\n`;
    }

    return sendMessage(userId, msg);
  }

  // ----------------------
  // BOT ADDED
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

      await supabase.from("channel_admins").upsert(
        {
          user_id: user.id,
          channel_id: chat.id,
        },
        { onConflict: "user_id,channel_id" }
      );

      return sendMessage(user.id, `✅ Connected: ${chat.title}`);
    }
  }

  // ----------------------
  // JOIN / LEAVE
  // ----------------------

  const cm = update.chat_member;
  if (!cm) return;

  const oldStatus = cm.old_chat_member.status;
  const newStatus = cm.new_chat_member.status;

  const isJoin =
    ["left", "kicked", "restricted"].includes(oldStatus) &&
    ["member", "administrator"].includes(newStatus);

  const isLeave =
    ["member", "administrator", "restricted"].includes(oldStatus) &&
    ["left", "kicked"].includes(newStatus);

  if (!isJoin && !isLeave) return;

  const user = cm.new_chat_member?.user;
  const channel = cm.chat;

  const eventTime = safeEventTime(cm);

  const username = user.username
    ? `@${user.username}`
    : user.first_name || "Unknown";

  const profile = user.username
    ? `https://t.me/${user.username}`
    : `tg://user?id=${user.id}`;

  const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

📢 ${channel.title}
👤 ${username}
🔗 <a href="${profile}">Profile</a>

⏰ ${eventTime.toLocaleString()}
`;

  // SEND FIRST (critical path)
  const { data: admins } = await supabase
    .from("channel_admins")
    .select("user_id")
    .eq("channel_id", channel.id);

  for (const a of admins || []) {
    sendMessage(a.user_id, message);
  }

  // DB LOG SECOND (non-blocking)
  try {
    await supabase.from("events").insert({
      channel_id: channel.id,
      user_id: user.id,
      username,
      event_type: isJoin ? "JOIN" : "LEAVE",
      event_time: eventTime.toISOString(),
    });
  } catch (e) {
    err("DB log failed (ignored):", e.message);
  }

  log("📊 Event:", isJoin ? "JOIN" : "LEAVE", username);
}

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Reliable webhook + queue system running");
});