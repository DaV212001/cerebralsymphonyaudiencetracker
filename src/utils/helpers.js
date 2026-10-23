const { ADMIN_USER_ID } = require("../config");

function escapeHtml(text = "") {
  return text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) {
    const remMins = minutes % 60;
    return `${hours}h ${remMins}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function safeTime(cm) {
  const t = cm?.date;
  return t ? new Date(t * 1000) : new Date();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function broadcastBody(text) {
  return `📣 <b>Update from ChannelSubTracker</b>\n\n${escapeHtml(text)}`;
}

function adminCommandLines(user) {
  if (!ADMIN_USER_ID || user.id !== ADMIN_USER_ID) return "";

  return `
/broadcast &lt;message&gt; — admin-only update message
/resumebroadcast [broadcast_id] — resume incomplete broadcast without duplicates
/editbroadcast &lt;broadcast_id&gt; &lt;message&gt; — admin-only edit`;
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

module.exports = {
  escapeHtml,
  formatDuration,
  safeTime,
  wait,
  DEFAULT_ADMIN_SETTINGS,
  adminSettings,
  notificationMode,
  channelDisplay,
  broadcastBody,
  adminCommandLines,
  batchMode,
  parseBatchWindow,
};
