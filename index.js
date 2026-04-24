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
// TELEGRAM SEND
// ----------------------

async function sendMessage(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    err("Send failed:", e.response?.data || e.message);
  }
}

// ----------------------
// WEBHOOK (ULTRA FAST ENTRY POINT)
// ----------------------

app.post("/webhook", async (req, res) => {
  const update = req.body;

  // 🔥 ALWAYS ACK FAST (critical for Telegram reliability)
  res.sendStatus(200);

  try {
    log("📥 Incoming:", update.update_id);

    const { error } = await supabase.from("raw_updates").upsert({
      update_id: update.update_id,
      payload: update,
      status: "pending",
    });

    if (error) {
      err("Queue insert error:", error);
    } else {
      log("✅ Queued:", update.update_id);
    }
  } catch (e) {
    err("Webhook crash:", e);
  }
});

// ----------------------
// CORE PROCESSOR (WORKER LOOP)
// ----------------------

async function processQueue() {
  try {
    const { data: items } = await supabase
      .from("raw_updates")
      .select("*")
      .or("status.eq.pending,status.eq.failed")
      .lt("retry_count", 5)
      .limit(10);

    if (!items?.length) {
      return setTimeout(processQueue, 1500);
    }

    for (const item of items) {
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
      } catch (e) {
        err("Processing failed:", item.update_id);

        await supabase
          .from("raw_updates")
          .update({
            status: "failed",
            retry_count: item.retry_count + 1,
          })
          .eq("id", item.id);
      }
    }

    setTimeout(processQueue, 800);
  } catch (e) {
    err("Queue loop error:", e);
    setTimeout(processQueue, 3000);
  }
}

processQueue();

// ----------------------
// MAIN LOGIC
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

      return sendMessage(
        user.id,
        `👋 <b>Bot Active</b>

📊 Tracking channel joins/leaves reliably.

Use /channels to view channels.`
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
        const link = c.channels.username
          ? `https://t.me/${c.channels.username}`
          : null;

        const title = link
          ? `<a href="${link}">${c.channels.title}</a>`
          : c.channels.title;

        msg += `• ${title} (<code>${c.channels.id}</code>)\n`;
      }

      return sendMessage(userId, msg);
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

        await supabase.from("channel_admins").upsert(
          {
            user_id: user.id,
            channel_id: chat.id,
          },
          { onConflict: ["user_id", "channel_id"] }
        );

        return sendMessage(user.id, `✅ Connected to <b>${chat.title}</b>`);
      }
    }

    // ----------------------
    // JOIN / LEAVE EVENTS
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

    const eventTime = new Date(cm.date * 1000);
    const delay = Date.now() - eventTime.getTime();

    const delayed = delay > 10000 ? "\n⚠️ <i>Delayed event</i>" : "";

    const username = user.username
      ? `@${user.username}`
      : user.first_name || "Unknown";

    const profile = user.username
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

    if (error && error.code !== "23505") {
      throw error;
    }

    const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

📢 ${channel.title}
👤 ${username}
🔗 <a href="${profile}">Profile</a>

⏰ ${eventTime.toLocaleString()}
${delayed}
`;

    const { data: admins } = await supabase
      .from("channel_admins")
      .select("user_id")
      .eq("channel_id", channel.id);

    for (const a of admins || []) {
      await sendMessage(a.user_id, message);
    }

    log("📊 Event:", isJoin ? "JOIN" : "LEAVE", username);
  } catch (e) {
    err("Handler error:", e);
  }
}

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Webhook-only bot running");
});