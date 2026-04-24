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
    if (retry < 3) {
      return setTimeout(
        () => sendMessage(chatId, text, retry + 1),
        1000 * (retry + 1)
      );
    }
    err("Send failed permanently:", e.response?.data || e.message);
  }
}

// ----------------------
// WEBHOOK ENTRY (FAST ACK)
// ----------------------

app.post("/webhook", async (req, res) => {
  const update = req.body;

  // IMPORTANT: always ACK immediately
  res.sendStatus(200);

  try {
    log("📥 Incoming:", update.update_id);

    const { error } = await supabase.from("raw_updates").insert({
      update_id: update.update_id,
      payload: update,
      status: "pending",
      retry_count: 0,
    });

    if (error?.code === "23505") {
      log("🔁 Duplicate update ignored:", update.update_id);
      return;
    }

    if (error) {
      err("Queue insert error:", error);
    } else {
      log("✅ Queued:", update.update_id);
    }
  } catch (e) {
    err("Webhook crash:", e.message);
  }
});

// ----------------------
// SAFE WORKER LOOP
// ----------------------

let running = false;

async function processQueue() {
  if (running) return;
  running = true;

  try {
    const { data: items } = await supabase
      .from("raw_updates")
      .select("*")
      .eq("status", "pending")
      .lt("retry_count", 5)
      .limit(10);

    if (!items?.length) {
      running = false;
      return setTimeout(processQueue, 1200);
    }

    // mark as processing FIRST (prevents double-processing)
    await supabase
      .from("raw_updates")
      .update({ status: "processing" })
      .in(
        "id",
        items.map((i) => i.id)
      );

    for (const item of items) {
      try {
        log("⚙️ Processing:", item.update_id);

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
  } catch (e) {
    err("Queue loop error:", e.message);
  }

  running = false;
  setTimeout(processQueue, 800);
}

processQueue();

// ----------------------
// MAIN HANDLER
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

📊 Tracking channel joins/leaves.

Use /channels to view connected channels.`
      );
    }

    if (update.message?.text === "/channels") {
      const userId = update.message.from.id;

      const { data } = await supabase
        .from("channel_admins")
        .select("channels(title,id,username)")
        .eq("user_id", userId);

      if (!data?.length) {
        return sendMessage(
          userId,
          `📭 <b>No channels connected</b>

Add me as admin in your channel first, then send /start.`
        );
      }

      let msg = "📺 <b>Your Channels</b>\n\n";

      for (const c of data) {
        const link = c.channels?.username
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
          { onConflict: "user_id,channel_id" }
        );

        return sendMessage(
          user.id,
          `✅ Connected to <b>${chat.title}</b>`
        );
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

    const user = cm.new_chat_member?.user;
    if (!user) return;

    const channel = cm.chat;

    const eventTime = new Date(cm.date * 1000);
    const delay = Date.now() - eventTime.getTime();

    const delayed =
      delay > 10000 ? "\n⚠️ <i>Delayed event detected</i>" : "";

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

    if (error?.code === "23505") {
      log("🔁 Duplicate event ignored");
      return;
    }

    if (error) throw error;

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
    err("Handler error:", e.message || e);
  }
}

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Webhook-only bot running (stable mode)");
});