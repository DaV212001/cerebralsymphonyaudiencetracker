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
// SAFE TELEGRAM SEND (RETRY)
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
// WEBHOOK (FAST ACK)
// ----------------------

app.post("/webhook", async (req, res) => {
  const update = req.body;

  // ALWAYS ACK FAST
  res.sendStatus(200);

  try {
    if (!update || typeof update !== "object") {
      log("⚠️ Invalid update received");
      return;
    }

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
      err("Queue insert error:", error.message);
    } else {
      log("✅ Queued:", update.update_id);
    }
  } catch (e) {
    err("Webhook crash:", e.message);
  }
});

// ----------------------
// WORKER LOOP (SAFE)
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
        err("Processing failed:", item.update_id, e.message);

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
        return sendMessage(userId, "📭 No channels connected yet.");
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

    // ----------------------
    // SAFE USER EXTRACTION
    // ----------------------

    const user =
      cm.new_chat_member?.user ||
      cm.old_chat_member?.user ||
      cm.from;

    if (!user) {
      log("⚠️ Missing user in update");
      return;
    }

    const channel = cm.chat;

    // ----------------------
    // SAFE TIMESTAMP
    // ----------------------

    let eventTime;

    if (
      typeof cm.date === "number" &&
      cm.date > 1000000000 &&
      cm.date < 4102444800
    ) {
      eventTime = new Date(cm.date * 1000);
    } else {
      eventTime = new Date();
      log("⚠️ Invalid timestamp fallback used:", cm.date);
    }

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
    // DB WRITE (NON-BLOCKING)
    // ----------------------

    let dbOk = true;

    try {
      const { error } = await supabase.from("events").insert({
        channel_id: channel.id,
        user_id: user.id,
        username,
        event_type: isJoin ? "JOIN" : "LEAVE",
        event_time: eventTime,
      });

      if (error?.code !== "23505") throw error;
    } catch (e) {
      dbOk = false;
      err("DB insert failed (non-fatal):", e.message);
    }

    // ----------------------
    // ADMIN NOTIFICATION (ALWAYS SENT)
    // ----------------------

    const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

📢 ${channel.title}
👤 ${username}
🔗 <a href="${profile}">Profile</a>

⏰ ${eventTime.toLocaleString()}
${delayed}
`;

    const prefix = dbOk
      ? ""
      : "⚠️ <i>DB temporarily failed (event may be recovered)</i>\n\n";

    const { data: admins } = await supabase
      .from("channel_admins")
      .select("user_id")
      .eq("channel_id", channel.id);

    for (const a of admins || []) {
      await sendMessage(a.user_id, prefix + message);
    }

    log("📊 Event:", isJoin ? "JOIN" : "LEAVE", username);
  } catch (e) {
    err("Handler error:", e.message || e);
  }
}

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Webhook-only bot running (fully hardened)");
});