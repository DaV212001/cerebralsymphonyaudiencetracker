const axios = require("axios");
const { TELEGRAM_API } = require("../config");
const { wait } = require("../utils/helpers");
const { err } = require("../utils/logger");

async function sendMessage(chatId, text, retry = 0) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
    return true;
  } catch (e) {
    const desc = e.response?.data?.description || "";

    if (desc.includes("can't parse entities")) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: text.replace(/<[^>]*>/g, ""),
      });
      return true;
    }

    if (retry < 4) {
      await wait(1000 * 2 ** retry);
      return sendMessage(chatId, text, retry + 1);
    }

    err("Telegram send failed:", e.response?.data || e.message);
    return false;
  }
}

async function sendTrackedMessage(chatId, text, retry = 0) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });

    return {
      ok: true,
      messageId: response.data?.result?.message_id,
    };
  } catch (e) {
    const desc = e.response?.data?.description || "";

    if (desc.includes("can't parse entities")) {
      const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: text.replace(/<[^>]*>/g, ""),
      });

      return {
        ok: true,
        messageId: response.data?.result?.message_id,
      };
    }

    if (retry < 4) {
      await wait(1000 * 2 ** retry);
      return sendTrackedMessage(chatId, text, retry + 1);
    }

    const error = e.response?.data?.description || e.message;
    err("Telegram tracked send failed:", error);
    return { ok: false, error };
  }
}

async function editTrackedMessage(chatId, messageId, text, retry = 0) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });

    return { ok: true };
  } catch (e) {
    const desc = e.response?.data?.description || "";

    if (desc.includes("message is not modified")) {
      return { ok: true };
    }

    if (desc.includes("can't parse entities")) {
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text: text.replace(/<[^>]*>/g, ""),
      });

      return { ok: true };
    }

    if (retry < 4) {
      await wait(1000 * 2 ** retry);
      return editTrackedMessage(chatId, messageId, text, retry + 1);
    }

    const error = e.response?.data?.description || e.message;
    err("Telegram edit failed:", error);
    return { ok: false, error };
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

module.exports = {
  sendMessage,
  sendTrackedMessage,
  editTrackedMessage,
  sendAnimation,
  getChannelMemberCount,
  getChatMember,
};
