require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || 0);
const GOAL_CELEBRATION_GIF_URL =
  process.env.GOAL_CELEBRATION_GIF_URL ||
  "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif";
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = {
  BOT_TOKEN,
  TELEGRAM_API,
  ADMIN_USER_ID,
  GOAL_CELEBRATION_GIF_URL,
  PORT,
  supabase,
};
