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
// HELPER: Send message
// ----------------------
async function sendMessageTo(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error("Send message error:", err.response?.data || err.message);
  }
}

// ----------------------
// WEBHOOK
// ----------------------
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // ----------------------
    // /start command
    // ----------------------
    if (update.message && update.message.text === "/start") {
      const user = update.message.from;

      await supabase.from("users").upsert({
        id: user.id,
        username: user.username || user.first_name,
      });

      await sendMessageTo(
        user.id,
        `👋 Welcome!

1. Add this bot as ADMIN to your channel
2. I’ll track joins & leaves
3. Use /channels to manage your channels`
      );
    }

    // ----------------------
    // /channels command
    // ----------------------
    if (update.message && update.message.text === "/channels") {
      const userId = update.message.from.id;

      const { data, error } = await supabase
        .from("channel_admins")
        .select("channels(title, id)")
        .eq("user_id", userId);

      if (error) throw error;

      if (!data || data.length === 0) {
        return sendMessageTo(userId, "📭 You have no connected channels.");
      }

      let msg = "📺 Your Channels:\n\n";

      data.forEach((c) => {
        msg += `• ${c.channels.title} (ID: ${c.channels.id})\n`;
      });

      await sendMessageTo(userId, msg);
    }

    // ----------------------
    // /unsubscribe <channel_id>
    // ----------------------
    if (
      update.message &&
      update.message.text &&
      update.message.text.startsWith("/unsubscribe")
    ) {
      const parts = update.message.text.split(" ");
      const channelId = parts[1];
      const userId = update.message.from.id;

      if (!channelId) {
        return sendMessageTo(
          userId,
          "⚠️ Usage: /unsubscribe <channel_id>"
        );
      }

      await supabase
        .from("channel_admins")
        .delete()
        .eq("user_id", userId)
        .eq("channel_id", channelId);

      await sendMessageTo(userId, "❌ Unsubscribed from channel.");
    }

    // ----------------------
    // BOT ADDED TO CHANNEL
    // ----------------------
    if (update.my_chat_member) {
      const chat = update.my_chat_member.chat;
      const user = update.my_chat_member.from;
      const newStatus = update.my_chat_member.new_chat_member.status;

      if (chat.type === "channel" && newStatus === "administrator") {
        // Save channel
        await supabase.from("channels").upsert({
          id: chat.id,
          title: chat.title,
        });

        // Save user
        await supabase.from("users").upsert({
          id: user.id,
          username: user.username || user.first_name,
        });

        // Link user to channel (ignore duplicates)
        await supabase.from("channel_admins").upsert(
          {
            user_id: user.id,
            channel_id: chat.id,
          },
          { onConflict: ["user_id", "channel_id"] }
        );

        await sendMessageTo(
          user.id,
          `✅ Bot connected to channel: ${chat.title}`
        );
      }
    }

    // ----------------------
    // JOIN / LEAVE TRACKING
    // ----------------------
    const chatMember = update.chat_member;

    if (chatMember) {
      const oldStatus = chatMember.old_chat_member.status;
      const newStatus = chatMember.new_chat_member.status;

      // ignore no-change events
      if (oldStatus === newStatus) return res.sendStatus(200);

      const user = chatMember.new_chat_member.user;
      const username =
        user.username || user.first_name || "Unknown";

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

      const message = `${
        eventType === "JOIN" ? "🟢 JOIN" : "🔴 LEAVE"
      }

👤 User: ${username}
⏰ Time: ${new Date().toLocaleString()}`;

      // Store event
      await supabase.from("events").insert({
        channel_id: channelId,
        username,
        event_type: eventType,
      });

      // Get all admins for this channel
      const { data: admins } = await supabase
        .from("channel_admins")
        .select("user_id")
        .eq("channel_id", channelId);

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
// START SERVER
// ----------------------
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Bot server running");
});