const axios = require("axios");
const { TELEGRAM_API } = require("../config");
const { wait } = require("../utils/helpers");
const { log, err } = require("../utils/logger");

const BOT_COMMANDS = [
  { command: "channels", description: "Interactive channel dashboard & list" },
  { command: "settings", description: "Channel notification & alert controls" },
  { command: "history", description: "Subscriber dossier, stint lifespan & tenure" },
  { command: "rejoiners", description: "Repeat & re-joining subscriber report" },
  { command: "backfill", description: "Backfill join date for existing member" },
  { command: "goal", description: "Set milestone subscriber goal" },
  { command: "goalstatus", description: "View progress bar towards subscriber goal" },
  { command: "goaloff", description: "Clear active subscriber goal" },
  { command: "notify", description: "Configure join/leave alert preferences" },
  { command: "hideuser", description: "Toggle member username privacy" },
  { command: "batch", description: "Batch rapid alerts (30s, 1m, 5m)" },
  { command: "unsubscribe", description: "Stop tracking a channel" },
  { command: "help", description: "Documentation and setup guide" },
  { command: "start", description: "Bot overview & onboarding" },
];

/**
 * Sends a message via Telegram Bot API with retry and HTML fallback.
 * Supports options (e.g. { reply_markup: { inline_keyboard: [...] } }).
 */
async function sendMessage(chatId, text, options = {}, retry = 0) {
  let opts = options;
  let r = retry;
  if (typeof options === "number") {
    r = options;
    opts = {};
  }

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    ...opts,
  };

  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return {
      ok: true,
      messageId: response.data?.result?.message_id,
      data: response.data?.result,
    };
  } catch (e) {
    const desc = e.response?.data?.description || "";

    if (desc.includes("can't parse entities")) {
      const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        ...payload,
        text: text.replace(/<[^>]*>/g, ""),
        parse_mode: undefined,
      });
      return {
        ok: true,
        messageId: response.data?.result?.message_id,
        data: response.data?.result,
      };
    }

    if (r < 4) {
      await wait(1000 * 2 ** r);
      return sendMessage(chatId, text, opts, r + 1);
    }

    err("Telegram send failed:", e.response?.data || e.message);
    return false;
  }
}

/**
 * Sends a tracked message and returns ok + messageId.
 */
async function sendTrackedMessage(chatId, text, options = {}, retry = 0) {
  const result = await sendMessage(chatId, text, options, retry);
  if (!result || !result.ok) {
    return { ok: false, error: "Telegram send failed" };
  }
  return {
    ok: true,
    messageId: result.messageId,
  };
}

/**
 * Edits an existing message's text and/or inline keyboard in-place.
 */
async function editMessageText(chatId, messageId, text, options = {}, retry = 0) {
  let opts = options;
  let r = retry;
  if (typeof options === "number") {
    r = options;
    opts = {};
  }

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    ...opts,
  };

  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, payload);
    return { ok: true };
  } catch (e) {
    const desc = e.response?.data?.description || "";

    if (desc.includes("message is not modified")) {
      return { ok: true };
    }

    if (desc.includes("can't parse entities")) {
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        ...payload,
        text: text.replace(/<[^>]*>/g, ""),
        parse_mode: undefined,
      });
      return { ok: true };
    }

    if (r < 4) {
      await wait(1000 * 2 ** r);
      return editMessageText(chatId, messageId, text, opts, r + 1);
    }

    const error = e.response?.data?.description || e.message;
    err("Telegram edit failed:", error);
    return { ok: false, error };
  }
}

/**
 * Alias for editMessageText for tracked broadcasts.
 */
async function editTrackedMessage(chatId, messageId, text, retry = 0) {
  return editMessageText(chatId, messageId, text, {}, retry);
}

/**
 * Answers a Telegram callback query to dismiss loading indicators.
 */
async function answerCallbackQuery(callbackQueryId, text = "", showAlert = false) {
  try {
    const payload = {
      callback_query_id: callbackQueryId,
      show_alert: !!showAlert,
    };
    if (text) {
      payload.text = text;
    }
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, payload);
    return true;
  } catch (e) {
    err("Telegram answerCallbackQuery failed:", e.response?.data || e.message);
    return false;
  }
}

async function sendAnimation(chatId, animation, caption, retry = 0) {
  try {
    await axios.post(`${TELEGRAM_API}/sendAnimation`, {
      chat_id: chatId,
      animation,
      caption,
      parse_mode: "HTML",
    });

    return true;
  } catch (e) {
    if (retry < 4) {
      await wait(1000 * 2 ** retry);
      return sendAnimation(chatId, animation, caption, retry + 1);
    }

    err("Telegram animation send failed:", e.response?.data || e.message);
    return false;
  }
}

async function getChannelMemberCount(channelId) {
  const response = await axios.post(`${TELEGRAM_API}/getChatMemberCount`, {
    chat_id: channelId,
  });

  return Number(response.data?.result || 0);
}

async function getChatMember(channelId, userId) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/getChatMember`, {
      chat_id: channelId,
      user_id: userId,
    });
    return response.data?.result || null;
  } catch (e) {
    return null;
  }
}

async function setBotCommands(commands = BOT_COMMANDS) {
  try {
    await axios.post(`${TELEGRAM_API}/setMyCommands`, {
      commands,
      scope: { type: "default" },
    });
    await axios.post(`${TELEGRAM_API}/setMyCommands`, {
      commands,
      scope: { type: "all_private_chats" },
    });
    log("Bot commands updated successfully on Telegram for default & private chat scopes");
    return true;
  } catch (e) {
    err("Telegram setMyCommands failed:", e.response?.data || e.message);
    return false;
  }
}

module.exports = {
  BOT_COMMANDS,
  sendMessage,
  sendTrackedMessage,
  editMessageText,
  editTrackedMessage,
  answerCallbackQuery,
  sendAnimation,
  getChannelMemberCount,
  getChatMember,
  setBotCommands,
};
