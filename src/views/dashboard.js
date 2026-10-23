const { escapeHtml, adminSettings, channelDisplay } = require("../utils/helpers");
const { renderProgressBar, goalMessage } = require("../services/goals");
const { buildRejoinersReport } = require("../reports/subscriberHistory");

/**
 * Builds the interactive Channel Dashboard text and inline keyboard toggles.
 * @param {Object} channelAdmin - The channel_admins row joined with channels table.
 * @param {Object|null} activeGoal - Active subscriber goal row (if any).
 * @returns {{ text: string, reply_markup: { inline_keyboard: Array } }}
 */
function buildDashboardView(channelAdmin, activeGoal = null) {
  const channel = channelAdmin.channels || {};
  const settings = adminSettings(channelAdmin);
  const channelId = channelAdmin.channel_id;

  // Notification Mode
  let notifStatus = "All (Joins & Leaves)";
  let notifBtn = "🔔 Alerts: All 🟢";
  if (settings.notify_joins && !settings.notify_leaves) {
    notifStatus = "Joins Only";
    notifBtn = "🔔 Alerts: Joins 🟡";
  } else if (!settings.notify_joins && settings.notify_leaves) {
    notifStatus = "Leaves Only";
    notifBtn = "🔔 Alerts: Leaves 🟠";
  } else if (!settings.notify_joins && !settings.notify_leaves) {
    notifStatus = "Muted (Off)";
    notifBtn = "🔕 Alerts: Muted 🔴";
  }

  // Username visibility
  const userStatus = settings.hide_usernames ? "Hidden" : "Visible";
  const userBtn = settings.hide_usernames
    ? "👤 Usernames: Hidden 🙈"
    : "👤 Usernames: Visible 👁";

  // Batching
  let batchStatus = "Instant (No batching)";
  let batchBtn = "⏱ Batch: Instant ⚡";
  if (settings.batch_window_seconds === 30) {
    batchStatus = "30 seconds";
    batchBtn = "⏱ Batch: 30s ⏳";
  } else if (settings.batch_window_seconds === 60) {
    batchStatus = "1 minute";
    batchBtn = "⏱ Batch: 1m ⏳";
  } else if (settings.batch_window_seconds === 300) {
    batchStatus = "5 minutes";
    batchBtn = "⏱ Batch: 5m ⏳";
  }

  // Subscriber Goal
  let goalLine = "None active <i>(use /goal)</i>";
  if (activeGoal && activeGoal.active) {
    const current = Number(activeGoal.last_count) || 0;
    const target = Number(activeGoal.target_count) || 0;
    const bar = renderProgressBar(current, target);
    goalLine = `\n   🎯 Target: <b>${target.toLocaleString()}</b>\n   📊 <code>${bar}</code> (${current.toLocaleString()}/${target.toLocaleString()})`;
  }

  const text = `🎛 <b>Channel Control Dashboard</b>

📢 ${channelDisplay(channel)}
🆔 Channel ID: <code>${channelId}</code>

━━━━━━━━━━━━━━
🔔 <b>Alerts:</b> <b>${notifStatus}</b>
👤 <b>Usernames:</b> <b>${userStatus}</b>
⏱ <b>Batching:</b> <b>${batchStatus}</b>
🎯 <b>Subscriber Goal:</b> ${goalLine}
━━━━━━━━━━━━━━
💡 <i>Tap any toggle button below to update settings instantly:</i>`;

  const inline_keyboard = [
    [{ text: notifBtn, callback_data: `cb:t_notif:${channelId}` }],
    [{ text: userBtn, callback_data: `cb:t_user:${channelId}` }],
    [{ text: batchBtn, callback_data: `cb:t_batch:${channelId}` }],
    [
      { text: "🎯 Goal Progress", callback_data: `cb:goal_view:${channelId}` },
      { text: "🔄 Re-joiners", callback_data: `cb:rejoin_view:${channelId}` },
    ],
    [
      { text: "🔄 Refresh", callback_data: `cb:refresh:${channelId}` },
      { text: "📋 All Channels", callback_data: "cb:ch_list" },
    ],
  ];

  return { text, reply_markup: { inline_keyboard } };
}

/**
 * Builds the interactive Channels List view with buttons to jump into each dashboard.
 * @param {Array} channelsList - Array of channel_admins rows with channels join.
 * @returns {{ text: string, reply_markup: { inline_keyboard: Array } }}
 */
function buildChannelsListView(channelsList) {
  let text = `📺 <b>Your Tracked Channels</b>\n\nSelect a channel below to open its control dashboard:`;

  const buttons = channelsList.map((c) => {
    const title = c.channels?.title || `Channel ${c.channel_id}`;
    return [{ text: `📢 ${title}`, callback_data: `cb:ch_view:${c.channel_id}` }];
  });

  return { text, reply_markup: { inline_keyboard: buttons } };
}

/**
 * Builds the Goal Detail view with visual progress bar and controls.
 */
function buildGoalDetailView(goal, channel, channelId) {
  if (!goal || !goal.active) {
    const text = `🎯 <b>Subscriber Goal</b>

${channelDisplay(channel)}
🆔 Channel ID: <code>${channelId}</code>

📭 No active goal is currently set for this channel.

To set a milestone goal, send:
<code>/goal ${channelId} 1000</code>`;

    const inline_keyboard = [
      [{ text: "🔙 Channel Dashboard", callback_data: `cb:ch_view:${channelId}` }],
    ];
    return { text, reply_markup: { inline_keyboard } };
  }

  const text = goalMessage(goal, channel, goal.last_count);
  const inline_keyboard = [
    [
      { text: "🔄 Refresh", callback_data: `cb:goal_view:${channelId}` },
      { text: "❌ Clear Goal", callback_data: `cb:goal_clear:${channelId}` },
    ],
    [{ text: "🔙 Channel Dashboard", callback_data: `cb:ch_view:${channelId}` }],
  ];
  return { text, reply_markup: { inline_keyboard } };
}

/**
 * Builds the Re-joiners Detail view with navigation back to the dashboard.
 */
function buildRejoinersDetailView(channel, events, channelId) {
  const report = buildRejoinersReport(channel, events);
  const inline_keyboard = [
    [
      { text: "🔄 Refresh", callback_data: `cb:rejoin_view:${channelId}` },
      { text: "🔙 Channel Dashboard", callback_data: `cb:ch_view:${channelId}` },
    ],
  ];
  return { text: report, reply_markup: { inline_keyboard } };
}

module.exports = {
  buildDashboardView,
  buildChannelsListView,
  buildGoalDetailView,
  buildRejoinersDetailView,
};
