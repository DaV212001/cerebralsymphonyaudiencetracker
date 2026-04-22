require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.json());

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ----------------------
// HELPERS
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
    console.error("Send error:", err.response?.data || err.message);
  }
}

function getChannelLink(channel) {
  if (channel?.username) {
    return `https://t.me/${channel.username}`;
  }
  return null;
}

// ----------------------
// WEBHOOK
// ----------------------
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // ----------------------
    // /start
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

🚀 Setup:
1. Add me as admin to your channel
2. I’ll auto-connect
3. Use /channels to manage

Use /channels to get started.`
      );
    }

    // ----------------------
    // /channels
    // ----------------------
    if (update.message?.text === "/channels") {
      const userId = update.message.from.id;

      const { data } = await supabase
        .from("channel_admins")
        .select("channels(title, id, username)")
        .eq("user_id", userId);

      if (!data?.length) {
        return sendMessageTo(userId, "📭 No connected channels yet.");
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
    // /unsubscribe
    // ----------------------
    if (update.message?.text?.startsWith("/unsubscribe")) {
      const parts = update.message.text.split(" ");
      const channelId = parts[1];
      const userId = update.message.from.id;

      if (!channelId) {
        return sendMessageTo(userId, "⚠️ Usage: /unsubscribe <channel_id>");
      }

      await supabase
        .from("channel_admins")
        .delete()
        .eq("user_id", userId)
        .eq("channel_id", channelId);

      return sendMessageTo(userId, "❌ Unsubscribed.");
    }

    // ----------------------
    // BOT ADDED TO CHANNEL
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

        await supabase.from("users").upsert({
          id: user.id,
          username: user.username || user.first_name,
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
    // JOIN / LEAVE EVENTS
    // ----------------------
    const chatMember = update.chat_member;

    if (chatMember) {
      const oldStatus = chatMember.old_chat_member.status;
      const newStatus = chatMember.new_chat_member.status;

      if (oldStatus === newStatus) return res.sendStatus(200);

      const user = chatMember.from;

      const username = user.username
        ? `@${user.username}`
        : user.first_name || "Unknown";

      const profileLink = user.username
        ? `https://t.me/${user.username}`
        : `tg://user?id=${user.id}`;

      const channel = chatMember.chat;
      const channelLink = getChannelLink(channel);

      const channelDisplay = channelLink
        ? `<a href="${channelLink}">${channel.title}</a>`
        : `<b>${channel.title}</b>`;

      let eventType = null;

      if (
        (oldStatus === "left" || oldStatus === "kicked") &&
        newStatus === "member"
      ) {
        eventType = "JOIN";
      }

      if (
        oldStatus === "member" &&
        (newStatus === "left" || newStatus === "kicked")
      ) {
        eventType = "LEAVE";
      }

      if (!eventType) return res.sendStatus(200);

      const message = `
<b>${eventType === "JOIN" ? "🟢 JOIN EVENT" : "🔴 LEAVE EVENT"}</b>

📢 <b>Channel:</b> ${channelDisplay}
🆔 <code>${channel.id}</code>

👤 <b>User:</b> ${username}
🔗 <a href="${profileLink}">Open Profile</a>

⏰ <b>Time:</b> ${new Date().toLocaleString()}
`;

      await supabase.from("events").insert({
        channel_id: channel.id,
        username,
        event_type: eventType,
      });

      const { data: admins } = await supabase
        .from("channel_admins")
        .select("user_id")
        .eq("channel_id", channel.id);

      if (admins) {
        for (const admin of admins) {
          await sendMessageTo(admin.user_id, message);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("ERROR:", err);
    res.sendStatus(200);
  }
});

// ----------------------
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Bot running");
});