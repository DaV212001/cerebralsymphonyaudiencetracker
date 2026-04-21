const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// 🔐 put your NEW token here (after you regenerate it)
const BOT_TOKEN = process.env.BOT_TOKEN;

// your Telegram user ID (so bot can notify you)
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function sendMessage(text) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: ADMIN_CHAT_ID,
    text,
  });
}

app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // Detect join/leave events
    const chatMember = update.chat_member || update.my_chat_member;

    if (chatMember) {
      const oldStatus = chatMember.old_chat_member.status;
      const newStatus = chatMember.new_chat_member.status;

      const user = chatMember.from;
      const username =
        user.username ? `@${user.username}` : `${user.first_name || "Unknown"}`;

      const time = new Date().toISOString();

      // JOIN
      if (
        (oldStatus === "left" || oldStatus === "kicked") &&
        newStatus === "member"
      ) {
        await sendMessage(`🟢 JOIN
User: ${username}
Time: ${time}`);
      }

      // LEAVE
      if (
        oldStatus === "member" &&
        (newStatus === "left" || newStatus === "kicked")
      ) {
        await sendMessage(`🔴 LEAVE
User: ${username}
Time: ${time}`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err.message);
    res.sendStatus(200);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot server running");
});