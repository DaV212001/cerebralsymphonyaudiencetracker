require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ----------------------
// LOGGING
// ----------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function errorLog(...args) {
  console.error(new Date().toISOString(), "❌", ...args);
}

// ----------------------
// TELEGRAM
// ----------------------

async function sendMessageTo(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    errorLog("Send error:", err.response?.data || err.message);
  }
}

// ----------------------
// WEBHOOK (FAST QUEUE)
// ----------------------

app.post("/webhook", async (req, res) => {
  const update = req.body;

  res.sendStatus(200); // 🔥 respond instantly

  try {
    const { error } = await supabase.from("raw_updates").upsert({
      update_id: update.update_id,
      payload: update,
      status: "pending",
    });

    if (error) {
      errorLog("Queue insert failed:", error);
    } else {
      log("📥 Queued:", update.update_id);
    }
  } catch (err) {
    errorLog("Webhook error:", err);
  }
});

// ----------------------
// UPDATE HANDLER
// ----------------------

async function handleUpdate(update) {
  try {
    // ----------------------
    // COMMANDS
    // ----------------------
    if (update.message?.text === "/start") {
      const user = update.message.from;

      await supabase.from("users").upsert({
        id: user.id,
        username: user.username || user.first_name,
      });

      return sendMessageTo(
        user.id,
        `👋 <b>Welcome</b>

📊 I track joins & leaves reliably.

Use /channels to get started.`
      );
    }

    // ----------------------
    // JOIN / LEAVE
    // ----------------------
    const cm = update.chat_member;
    if (!cm) return;

    const oldStatus = cm.old_chat_member.status;
    const newStatus = cm.new_chat_member.status;

    if (oldStatus === newStatus) return;

    const isJoin =
      ["left", "kicked", "restricted"].includes(oldStatus) &&
      ["member", "administrator"].includes(newStatus);

    const isLeave =
      ["member", "administrator", "restricted"].includes(oldStatus) &&
      ["left", "kicked"].includes(newStatus);

    if (!isJoin && !isLeave) return;

    const user = cm.new_chat_member.user;
    const channel = cm.chat;

    // 🔥 TRUE EVENT TIME (from Telegram)
    const eventTime = new Date(cm.date * 1000);

    // 🔥 DELAY DETECTION
    const delayMs = Date.now() - eventTime.getTime();
    const isDelayed = delayMs > 10000;

    const username = user.username
      ? `@${user.username}`
      : user.first_name || "Unknown";

    const profileLink = user.username
      ? `https://t.me/${user.username}`
      : `tg://user?id=${user.id}`;

    // ----------------------
    // SAVE EVENT (DEDUP SAFE)
    // ----------------------
    const { error } = await supabase.from("events").insert({
      channel_id: channel.id,
      user_id: user.id,
      username,
      event_type: isJoin ? "JOIN" : "LEAVE",
      event_time: eventTime,
    });

    if (error) {
      // duplicate → skip silently
      if (error.code === "23505") {
        log("⚠️ Duplicate skipped:", update.update_id);
        return;
      }

      throw error;
    }

    // ----------------------
    // MESSAGE
    // ----------------------
    const apology = isDelayed
      ? "\n⚠️ <i>Delayed notification due to downtime.</i>"
      : "";

    const message = `
<b>${isJoin ? "🟢 JOIN EVENT" : "🔴 LEAVE EVENT"}</b>

📢 <b>${channel.title}</b>
🆔 <code>${channel.id}</code>

👤 <b>${username}</b>
🔗 <a href="${profileLink}">Profile</a>

⏰ ${eventTime.toLocaleString()}
${apology}
`;

    const { data: admins } = await supabase
      .from("channel_admins")
      .select("user_id")
      .eq("channel_id", channel.id);

    if (admins) {
      for (const admin of admins) {
        await sendMessageTo(admin.user_id, message);
      }
    }

    log("📊 Event:", isJoin ? "JOIN" : "LEAVE", username);
  } catch (err) {
    errorLog("handleUpdate error:", err);
    throw err;
  }
}

// ----------------------
// WORKER
// ----------------------

async function processQueue() {
  try {
    const { data: updates } = await supabase
      .from("raw_updates")
      .select("*")
      .or("status.eq.pending,status.eq.failed")
      .lt("retry_count", 5)
      .limit(10);

    if (!updates?.length) {
      return setTimeout(processQueue, 2000);
    }

    for (const item of updates) {
      try {
        log("⚙️ Processing:", item.update_id);

        await supabase
          .from("raw_updates")
          .update({ status: "processing" })
          .eq("id", item.id);

        await handleUpdate(item.payload);

        await supabase
          .from("raw_updates")
          .update({
            status: "done",
            processed_at: new Date(),
          })
          .eq("id", item.id);

        log("✅ Done:", item.update_id);
      } catch (err) {
        await supabase
          .from("raw_updates")
          .update({
            status: "failed",
            retry_count: item.retry_count + 1,
          })
          .eq("id", item.id);

        errorLog("Retrying:", item.update_id);
      }
    }

    setTimeout(processQueue, 1000);
  } catch (err) {
    errorLog("Worker error:", err);
    setTimeout(processQueue, 3000);
  }
}

processQueue();

// ----------------------
// POLLING (RECOVERY + OFFSET)
// ----------------------

let offset = 0;

// load offset on startup
async function loadOffset() {
  const { data } = await supabase
    .from("bot_state")
    .select("value")
    .eq("key", "offset")
    .single();

  offset = data ? parseInt(data.value) : 0;
  log("🔄 Loaded offset:", offset);
}

async function saveOffset() {
  await supabase.from("bot_state").upsert({
    key: "offset",
    value: offset.toString(),
  });
}

async function pollBackup() {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: { offset, timeout: 10 },
    });

    for (const update of res.data.result) {
      offset = update.update_id + 1;

      await supabase.from("raw_updates").upsert({
        update_id: update.update_id,
        payload: update,
        status: "pending",
      });

      log("🔁 Polled:", update.update_id);
    }

    await saveOffset();
  } catch (err) {
    errorLog("Polling error:", err.message);
  }

  setTimeout(pollBackup, 2000);
}

// ----------------------
// STARTUP
// ----------------------

async function start() {
  await loadOffset();
  pollBackup(); // 🔥 ENABLED
}

start();

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Server running");
});