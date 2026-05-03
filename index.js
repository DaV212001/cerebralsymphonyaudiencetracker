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
// HTML ESCAPE
// ----------------------

function escapeHtml(text = "") {
  return text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ----------------------
// HEALTH
// ----------------------

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
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
      disable_web_page_preview: false,
    });
  } catch (e) {
    const desc = e.response?.data?.description || "";

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
        1000 * 2 ** retry
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
  return t ? new Date(t * 1000) : new Date();
}

// ----------------------
// WEBHOOK
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

  // ----------------------
  // COMMANDS (only if message exists)
  // ----------------------

  if (msg && user) {

    // ----------------------
// START (FULL INSTRUCTIONS)
// ----------------------
if (msg === "/start") {
  await supabase.from("users").upsert({
    id: user.id,
    username: user.username || user.first_name,
  });

  return sendMessage(
    user.id,
`👋 <b>Welcome to Cerebral Symphony Tracker</b>

📊 <b>What this bot does:</b>
• Tracks channel joins
• Tracks channel leaves
• Sends real-time alerts
• Stores event history reliably

━━━━━━━━━━━━━━
⚙️ <b>Setup Instructions:</b>

1️⃣ Add this bot as an <b>ADMIN</b> in your channel  
2️⃣ Enable <b>"View Members"</b> permission  
3️⃣ Send /channels to confirm connection  

━━━━━━━━━━━━━━
📌 <b>Commands:</b>

/channels — view your channels  
/help — show help menu  
/unsubscribe &lt;channel_id&gt; — stop tracking  

━━━━━━━━━━━━━━
⚡ <i>Once added, tracking starts automatically.</i>`
  );
}

// ----------------------
// HELP (FULL GUIDE)
// ----------------------
if (msg === "/help") {
  return sendMessage(
    user.id,
`📘 <b>Help Menu</b>

━━━━━━━━━━━━━━
📊 <b>Features:</b>
• Real-time join/leave tracking  
• Automatic event logging  
• Reliable retry system (no missed events)  

━━━━━━━━━━━━━━
⚙️ <b>How to Use:</b>

1. Add bot as admin in your channel  
2. Enable <b>"View Members"</b>  
3. Use /channels to verify  

━━━━━━━━━━━━━━
📌 <b>Commands:</b>

/start — setup instructions  
/channels — list your channels  
/unsubscribe &lt;channel_id&gt; — stop tracking  
/help — show this menu  

━━━━━━━━━━━━━━
🧠 <i>Tip:</i>  
Use the channel ID from /channels when unsubscribing.`
  );
}

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

        const display = ch?.username
          ? `<a href="https://t.me/${ch.username}">${escapeHtml(ch.title)}</a>`
          : `<b>${escapeHtml(ch?.title || "Unknown")}</b>`;

        out += `• ${display}\n<code>${c.channel_id}</code>\n\n`;
      }

      return sendMessage(user.id, out);
    }

    if (msg.startsWith("/unsubscribe")) {
      const channelId = msg.split(" ")[1];

      if (!channelId) {
        return sendMessage(user.id, "❌ Usage: /unsubscribe <channel_id>");
      }

      const { data: ch } = await supabase
        .from("channels")
        .select("title, username")
        .eq("id", channelId)
        .single();

      const link = ch?.username
        ? `<a href="https://t.me/${ch.username}">${escapeHtml(ch.title)}</a>`
        : `<b>${escapeHtml(ch?.title || "Channel")}</b>`;

      await supabase
        .from("channel_admins")
        .delete()
        .eq("user_id", user.id)
        .eq("channel_id", channelId);

      return sendMessage(user.id, `🛑 Unsubscribed from ${link}`);
    }
  }

  // ----------------------
  // JOIN / LEAVE EVENTS (NO user guard)
  // ----------------------

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

// ----------------------
// USER DISPLAY (CONTACT STYLE)
// ----------------------
const displayName = escapeHtml(
  u.username ? `${u.username}` : u.first_name || "User"
);

// clickable contact
const contactLink = u.username
  ? `<a href="https://t.me/${u.username}">${displayName}</a>`
  : `<a href="tg://user?id=${u.id}">${displayName}</a>`;

// ----------------------
// CHANNEL LINK
// ----------------------
const channelLink = channel.username
  ? `<a href="https://t.me/${channel.username}">${escapeHtml(channel.title)}</a>`
  : `<b>${escapeHtml(channel.title)}</b>`;

// ----------------------
// FINAL MESSAGE (UPDATED FORMAT)
// ----------------------
const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

👤 ${contactLink}
━━━━━━━━━━━━━━
📢 ${channelLink}

🆔 Channel ID: <code>${channel.id}</code>
━━━━━━━━━━━━━━
⏰ ${time.toLocaleString()}
`;

const { data: admins } = await supabase
  .from("channel_admins")
  .select("user_id")
  .eq("channel_id", channel.id);

for (const a of admins || []) {
  sendMessage(a.user_id, message);
}

// DB log
const { error: eventInsertError } = await supabase.from("events").insert({
  channel_id: channel.id,
  user_id: u.id,
  username: u.username || u.first_name,
  event_type: isJoin ? "JOIN" : "LEAVE",
  event_time: time.toISOString(),
});

if (eventInsertError) {
  err("event log insert failed:", eventInsertError.message, {
    channel_id: channel.id,
    user_id: u.id,
    event_type: isJoin ? "JOIN" : "LEAVE",
  });
}

log("event:", isJoin ? "JOIN" : "LEAVE", displayName);
}

// ----------------------

app.listen(process.env.PORT || 3000, () => {
  log("🚀 Fully stable tracker running");
});
