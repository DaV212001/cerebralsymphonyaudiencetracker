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
// ADMIN SETTINGS
// ----------------------

const DEFAULT_ADMIN_SETTINGS = {
  notify_joins: true,
  notify_leaves: true,
  hide_usernames: false,
  batch_window_seconds: 0,
};

function adminSettings(row = {}) {
  return {
    notify_joins: row.notify_joins ?? DEFAULT_ADMIN_SETTINGS.notify_joins,
    notify_leaves: row.notify_leaves ?? DEFAULT_ADMIN_SETTINGS.notify_leaves,
    hide_usernames: row.hide_usernames ?? DEFAULT_ADMIN_SETTINGS.hide_usernames,
    batch_window_seconds:
      row.batch_window_seconds ?? DEFAULT_ADMIN_SETTINGS.batch_window_seconds,
  };
}

function notificationMode(settings) {
  if (settings.notify_joins && settings.notify_leaves) return "joins and leaves";
  if (settings.notify_joins) return "joins only";
  if (settings.notify_leaves) return "leaves only";
  return "off";
}

function channelDisplay(channel) {
  return channel?.username
    ? `<a href="https://t.me/${channel.username}">${escapeHtml(channel.title)}</a>`
    : `<b>${escapeHtml(channel?.title || "Channel")}</b>`;
}

function batchMode(settings) {
  const seconds = Number(settings.batch_window_seconds || 0);
  if (!seconds) return "instant";
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

function parseBatchWindow(value) {
  if (!value || value === "off" || value === "instant") return 0;

  const match = value.match(/^(\d+)(s|m)?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const seconds = unit === "m" ? amount * 60 : amount;

  if (seconds < 10 || seconds > 3600) return null;
  return seconds;
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
// NOTIFICATION BATCHES
// ----------------------

function eventWord(eventType, count) {
  const word = eventType === "JOIN" ? "join" : "leave";
  return count === 1 ? word : `${word}s`;
}

function batchMessage(row) {
  const channel = {
    title: row.channel_title,
    username: row.channel_username,
  };

  return `
<b>${row.event_type === "JOIN" ? "JOIN" : "LEAVE"} SUMMARY</b>

${row.count} ${eventWord(row.event_type, row.count)} during recent activity
━━━━━━━━━━━━━━
📢 ${channelDisplay(channel)}

🆔 Channel ID: <code>${row.channel_id}</code>
━━━━━━━━━━━━━━
First: ${new Date(row.first_event_at).toLocaleString()}
Latest: ${new Date(row.last_event_at).toLocaleString()}
`;
}

async function queueBatchNotification({ admin, settings, channel, eventType, time }) {
  const now = new Date();
  const flushAt = new Date(
    now.getTime() + settings.batch_window_seconds * 1000
  ).toISOString();

  const { data: existing, error: selectError } = await supabase
    .from("notification_batches")
    .select("id, count, first_event_at")
    .eq("status", "pending")
    .eq("user_id", admin.user_id)
    .eq("channel_id", channel.id)
    .eq("event_type", eventType)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("notification_batches")
      .update({
        count: (existing.count || 0) + 1,
        last_event_at: time.toISOString(),
        flush_at: flushAt,
        channel_title: channel.title,
        channel_username: channel.username || null,
      })
      .eq("id", existing.id);

    if (updateError) throw updateError;
    return;
  }

  const { error: insertError } = await supabase
    .from("notification_batches")
    .insert({
      user_id: admin.user_id,
      channel_id: channel.id,
      event_type: eventType,
      count: 1,
      first_event_at: time.toISOString(),
      last_event_at: time.toISOString(),
      flush_at: flushAt,
      status: "pending",
      channel_title: channel.title,
      channel_username: channel.username || null,
    });

  if (insertError) throw insertError;
}

async function flushDueBatches() {
  const { data: batches, error: selectError } = await supabase
    .from("notification_batches")
    .select("*")
    .eq("status", "pending")
    .lte("flush_at", new Date().toISOString())
    .limit(20);

  if (selectError) {
    err("batch select failed:", selectError.message);
    return;
  }

  if (!batches?.length) return;

  await supabase
    .from("notification_batches")
    .update({ status: "processing" })
    .in("id", batches.map((b) => b.id));

  for (const batch of batches) {
    try {
      await sendMessage(batch.user_id, batchMessage(batch));

      await supabase
        .from("notification_batches")
        .update({ status: "done", sent_at: new Date().toISOString() })
        .eq("id", batch.id);
    } catch (e) {
      err("batch send failed:", e.message);

      await supabase
        .from("notification_batches")
        .update({
          status: "pending",
          flush_at: new Date(Date.now() + 60000).toISOString(),
        })
        .eq("id", batch.id);
    }
  }
}

// ----------------------
// WORKER
// ----------------------

let running = false;

async function worker() {
  if (running) return;
  running = true;

  try {
    await flushDueBatches();

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
/settings &lt;channel_id&gt; — view channel notification settings  
/notify &lt;channel_id&gt; all|joins|leaves — choose alerts  
/hideuser &lt;channel_id&gt; on|off — hide or show usernames  
/batch &lt;channel_id&gt; off|30s|1m|5m — batch rapid alerts  
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
• Choose all alerts, joins only, or leaves only  
• Hide joiner/leaver usernames in notifications  
• Batch rapid activity into summary notifications  

━━━━━━━━━━━━━━
⚙️ <b>How to Use:</b>

1. Add bot as admin in your channel  
2. Enable <b>"View Members"</b>  
3. Use /channels to verify  

━━━━━━━━━━━━━━
📌 <b>Commands:</b>

/start — setup instructions  
/channels — list your channels  
/settings &lt;channel_id&gt; — view notification settings  
/notify &lt;channel_id&gt; all|joins|leaves — choose alerts  
/hideuser &lt;channel_id&gt; on|off — hide or show usernames  
/batch &lt;channel_id&gt; off|30s|1m|5m — batch rapid alerts  
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
        .select("channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)")
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

        const settings = adminSettings(c);
        const usernameMode = settings.hide_usernames ? "hidden" : "visible";

        out += `• ${display}\n<code>${c.channel_id}</code>\nAlerts: ${notificationMode(settings)}\nUsernames: ${usernameMode}\nBatching: ${batchMode(settings)}\n\n`;
      }

      return sendMessage(user.id, out);
    }

    if (msg.startsWith("/settings")) {
      const channelId = msg.split(/\s+/)[1];

      if (!channelId) {
        return sendMessage(user.id, "❌ Usage: /settings &lt;channel_id&gt;");
      }

      const { data: row, error: settingsError } = await supabase
        .from("channel_admins")
        .select("channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)")
        .eq("user_id", user.id)
        .eq("channel_id", channelId)
        .single();

      if (settingsError || !row) {
        return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
      }

      const settings = adminSettings(row);
      return sendMessage(
        user.id,
`⚙️ <b>Notification Settings</b>

📢 ${channelDisplay(row.channels)}
🆔 Channel ID: <code>${row.channel_id}</code>

Alerts: <b>${notificationMode(settings)}</b>
Usernames: <b>${settings.hide_usernames ? "hidden" : "visible"}</b>
Batching: <b>${batchMode(settings)}</b>

Commands:
/notify ${row.channel_id} all
/notify ${row.channel_id} joins
/notify ${row.channel_id} leaves
/hideuser ${row.channel_id} on
/hideuser ${row.channel_id} off
/batch ${row.channel_id} off
/batch ${row.channel_id} 1m`
      );
    }

    if (msg.startsWith("/notify")) {
      const [, channelId, mode] = msg.split(/\s+/);
      const allowedModes = new Set(["all", "joins", "leaves"]);

      if (!channelId || !allowedModes.has(mode)) {
        return sendMessage(user.id, "❌ Usage: /notify &lt;channel_id&gt; all|joins|leaves");
      }

      const nextSettings = {
        notify_joins: mode !== "leaves",
        notify_leaves: mode !== "joins",
      };

      const { data, error: updateError } = await supabase
        .from("channel_admins")
        .update(nextSettings)
        .eq("user_id", user.id)
        .eq("channel_id", channelId)
        .select("channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)")
        .single();

      if (updateError || !data) {
        return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
      }

      const settings = adminSettings(data);
      return sendMessage(
        user.id,
        `✅ Alerts for ${channelDisplay(data.channels)} set to <b>${notificationMode(settings)}</b>.`
      );
    }

    if (msg.startsWith("/hideuser")) {
      const [, channelId, mode] = msg.split(/\s+/);
      const allowedModes = new Set(["on", "off"]);

      if (!channelId || !allowedModes.has(mode)) {
        return sendMessage(user.id, "❌ Usage: /hideuser &lt;channel_id&gt; on|off");
      }

      const { data, error: updateError } = await supabase
        .from("channel_admins")
        .update({ hide_usernames: mode === "on" })
        .eq("user_id", user.id)
        .eq("channel_id", channelId)
        .select("channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)")
        .single();

      if (updateError || !data) {
        return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
      }

      const settings = adminSettings(data);
      return sendMessage(
        user.id,
        `✅ Usernames for ${channelDisplay(data.channels)} are now <b>${settings.hide_usernames ? "hidden" : "visible"}</b>.`
      );
    }

    if (msg.startsWith("/batch")) {
      const [, channelId, windowValue] = msg.split(/\s+/);
      const seconds = parseBatchWindow(windowValue);

      if (!channelId || seconds === null) {
        return sendMessage(user.id, "❌ Usage: /batch &lt;channel_id&gt; off|30s|1m|5m");
      }

      const { data, error: updateError } = await supabase
        .from("channel_admins")
        .update({ batch_window_seconds: seconds })
        .eq("user_id", user.id)
        .eq("channel_id", channelId)
        .select("channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)")
        .single();

      if (updateError || !data) {
        return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
      }

      const settings = adminSettings(data);
      return sendMessage(
        user.id,
        `✅ Batching for ${channelDisplay(data.channels)} set to <b>${batchMode(settings)}</b>.`
      );
    }

    if (msg.startsWith("/unsubscribe")) {
      const channelId = msg.split(" ")[1];

      if (!channelId) {
        return sendMessage(user.id, "❌ Usage: /unsubscribe &lt;channel_id&gt;");
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

const { data: admins } = await supabase
  .from("channel_admins")
  .select("user_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds")
  .eq("channel_id", channel.id);

for (const a of admins || []) {
  const settings = adminSettings(a);

  if (isJoin && !settings.notify_joins) continue;
  if (isLeave && !settings.notify_leaves) continue;

  if (settings.batch_window_seconds > 0) {
    await queueBatchNotification({
      admin: a,
      settings,
      channel,
      eventType: isJoin ? "JOIN" : "LEAVE",
      time,
    });
    continue;
  }

  const userLine = settings.hide_usernames
    ? (isJoin ? "A user joined" : "A user left")
    : contactLink;

  const message = `
<b>${isJoin ? "🟢 JOIN" : "🔴 LEAVE"}</b>

👤 ${userLine}
━━━━━━━━━━━━━━
📢 ${channelLink}

🆔 Channel ID: <code>${channel.id}</code>
━━━━━━━━━━━━━━
⏰ ${time.toLocaleString()}
`;

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
