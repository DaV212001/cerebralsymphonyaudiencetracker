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
// LOG HELPERS
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

  // 🔥 ALWAYS RESPOND FAST
  res.sendStatus(200);

  try {
    log("📥 Incoming update:", update.update_id);

    const { error } = await supabase.from("raw_updates").upsert({
      update_id: update.update_id,
      payload: update,
      status: "pending",
    });

    if (error) {
      errorLog("Queue insert failed:", error);
    } else {
      log("✅ Queued update:", update.update_id);
    }
  } catch (err) {
    errorLog("Webhook error:", err);
  }
});

// ----------------------
// UPDATE HANDLER
// ----------------------

async function handleUpdate(update, createdAt) {
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

📊 I track channel joins & leaves in real-time.

Use /channels to get started.`
      );
    }

    if (update.message?.text === "/channels") {
      const userId = update.message.from.id;

      const { data } = await supabase
        .from("channel_admins")
        .select("channels(title, id, username)")
        .eq("user_id", userId);

      if (!data?.length) {
        return sendMessageTo(userId, "📭 No channels yet.");
      }

      let msg = "📺 <b>Your Channels</b>\n\n";

      data.forEach((c) => {
        const link = c.channels.username
          ? `https://t.me/${c.channels.username}`
          : null;

        const title = link
          ? `<a href="${link}">${c.channels.title}</a>`
          : c.channels.title;

        msg += `• ${title} (<code>${c.channels.id}</code>)\n`;
      });

      return sendMessageTo(userId, msg);
    }

    // ----------------------
    // BOT ADDED
    // ----------------------
    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      const user = update.my_chat_member.from;
      const status = update.my_chat_member.new_chat_member.status;

      if (chat.type === "channel" && status === "administrator") {
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
          { onConflict: ["user_id", "channel_id"] }
        );

        return sendMessageTo(
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

    const username = user.username
      ? `@${user.username}`
      : user.first_name || "Unknown";

    const profileLink = user.username
      ? `https://t.me/${user.username}`
      : `tg://user?id=${user.id}`;

    const channel = cm.chat;

    // ⏱ Delay detection
    const delayMs = Date.now() - new Date(createdAt).getTime();
    const isDelayed = delayMs > 10000;

    const apology = isDelayed
      ? "\n⚠️ <i>Delayed notification due to system lag.</i>"
      : "";

    const message = `
<b>${isJoin ? "🟢 JOIN EVENT" : "🔴 LEAVE EVENT"}</b>

📢 <b>${channel.title}</b>
🆔 <code>${channel.id}</code>

👤 <b>${username}</b>
🔗 <a href="${profileLink}">Profile</a>

⏰ ${new Date().toLocaleString()}
${apology}
`;

    // Save event
    const { error } = await supabase.from("events").insert({
      channel_id: channel.id,
      username,
      event_type: isJoin ? "JOIN" : "LEAVE",
    });

    if (error) {
      errorLog("Event insert failed:", error);
    }

    // Notify admins
    const { data: admins } = await supabase
      .from("channel_admins")
      .select("user_id")
      .eq("channel_id", channel.id);

    if (admins) {
      for (const admin of admins) {
        await sendMessageTo(admin.user_id, message);
      }
    }

    log("📊 Event processed:", isJoin ? "JOIN" : "LEAVE", username);
  } catch (err) {
    errorLog("handleUpdate error:", err);
    throw err;
  }
}

// ----------------------
// WORKER (QUEUE PROCESSOR)
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

        await handleUpdate(item.payload, item.created_at);

        await supabase
          .from("raw_updates")
          .update({
            status: "done",
            processed_at: new Date(),
          })
          .eq("id", item.id);

        log("✅ Done:", item.update_id);
      } catch (err) {
        errorLog("Processing failed:", item.update_id);

        await supabase
          .from("raw_updates")
          .update({
            status: "failed",
            retry_count: item.retry_count + 1,
          })
          .eq("id", item.id);
      }
    }

    setTimeout(processQueue, 1000);
  } catch (err) {
    errorLog("Worker loop error:", err);
    setTimeout(processQueue, 3000);
  }
}

processQueue();

// ----------------------
// OPTIONAL POLLING BACKUP
// ----------------------

let offset = 0;

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

      log("🔁 Polled update:", update.update_id);
    }
  } catch (err) {
    errorLog("Polling error:", err.message);
  }

  setTimeout(pollBackup, 2000);
}

// Enable if needed
// pollBackup();

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Server running");
});