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
    console.error("Send message error:", err.response?.data || err.message);
  }
}

async function getUserPhoto(userId) {
  try {
    const res = await axios.get(`${TELEGRAM_API}/getUserProfilePhotos`, {
      params: { user_id: userId, limit: 1 },
    });

    const photos = res.data.result.photos;
    if (!photos || photos.length === 0) return null;

    const fileId = photos[0][0].file_id;

    const fileRes = await axios.get(`${TELEGRAM_API}/getFile`, {
      params: { file_id: fileId },
    });

    const filePath = fileRes.data.result.file_path;

    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  } catch (err) {
    return null;
  }
}

async function sendPhotoTo(chatId, photoUrl, caption) {
  if (!photoUrl) {
    return sendMessageTo(chatId, caption);
  }

  try {
    await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("Photo send error:", err.message);
    await sendMessageTo(chatId, caption);
  }
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
        `👋 <b>Welcome to Channel Tracker</b>

📊 I monitor joins & leaves in your Telegram channels.

🚀 Setup:
1. Add me as ADMIN to your channel
2. I’ll automatically connect
3. Start receiving live updates

Use /channels to manage your channels.`
      );
    }

    // ----------------------
    // /channels
    // ----------------------
    if (update.message?.text === "/channels") {
      const userId = update.message.from.id;

      const { data } = await supabase
        .from("channel_admins")
        .select("channels(title, id)")
        .eq("user_id", userId);

      if (!data || data.length === 0) {
        return sendMessageTo(userId, "📭 No connected channels yet.");
      }

      let msg = "📺 <b>Your Channels</b>\n\n";

      data.forEach((c) => {
        msg += `• ${c.channels.title} (<code>${c.channels.id}</code>)\n`;
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

      return sendMessageTo(userId, "❌ Unsubscribed from channel.");
    }

    // ----------------------
    // BOT ADDED TO CHANNEL
    // ----------------------
    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      const user = update.my_chat_member.from;
      const newStatus = update.my_chat_member.new_chat_member.status;

      if (chat.type === "channel" && newStatus === "administrator") {
        await supabase.from("channels").upsert({
          id: chat.id,
          title: chat.title,
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

      const photoUrl = await getUserPhoto(user.id);

      const channelId = chatMember.chat.id;

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

👤 <b>User:</b> ${username}
🔗 <a href="${profileLink}">Open Profile</a>
⏰ <b>Time:</b> ${new Date().toLocaleString()}
      `;

      await supabase.from("events").insert({
        channel_id: channelId,
        username,
        event_type: eventType,
      });

      const { data: admins } = await supabase
        .from("channel_admins")
        .select("user_id")
        .eq("channel_id", channelId);

      if (admins) {
        for (const admin of admins) {
          await sendPhotoTo(admin.user_id, photoUrl, message);
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
// START SERVER
// ----------------------
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Bot server running");
});