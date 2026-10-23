const { supabase, GOAL_CELEBRATION_GIF_URL } = require("../config");
const { channelDisplay, escapeHtml } = require("../utils/helpers");
const { sendMessage, sendAnimation } = require("./telegram");
const { err } = require("../utils/logger");

/**
 * Renders a high-resolution Unicode visual progress bar.
 * @param {number} current - Current subscriber count.
 * @param {number} target - Target subscriber count.
 * @param {number} length - Number of bar characters (default 12).
 * @returns {string} E.g. "[█████████░░░] 74.2%"
 */
function renderProgressBar(current, target, length = 12) {
  const cur = Number(current) || 0;
  const tgt = Number(target) || 0;
  if (tgt <= 0) return "";
  const ratio = Math.max(0, cur / tgt);
  const percentClamped = Math.min(ratio, 1.0);
  const filled = Math.round(percentClamped * length);
  const empty = length - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pctStr = (ratio * 100).toFixed(1);
  return `[${bar}] ${pctStr}%`;
}

function goalMessage(goal, channel, count) {
  const target = Number(goal.target_count) || 0;
  const current = Number(count) || 0;
  const remaining = Math.max(target - current, 0);
  const bar = renderProgressBar(current, target);

  if (remaining <= 0) {
    return `🎉 <b>Subscriber Goal Reached!</b>

${channelDisplay(channel)}

🎯 Goal Target: <b>${target.toLocaleString()}</b>
👥 Current Count: <b>${current.toLocaleString()}</b>
📊 Progress: <code>${bar}</code>

🏆 <i>Milestone achieved! To set a new goal, send:</i>
<code>/goal ${goal.channel_id} &lt;target&gt;</code>`;
  }

  return `🎯 <b>Subscriber Goal Progress</b>

${channelDisplay(channel)}
🆔 Channel ID: <code>${goal.channel_id}</code>

📊 Progress: <code>${bar}</code>
🎯 Target: <b>${target.toLocaleString()}</b>
👥 Current: <b>${current.toLocaleString()}</b>
⏳ Remaining: <b>${remaining.toLocaleString()}</b>`;
}

async function handleGoalProgress({ admin, channel, isJoin, isLeave }) {
  const { data: goal, error: goalError } = await supabase
    .from("subscriber_goals")
    .select("*")
    .eq("user_id", admin.user_id)
    .eq("channel_id", channel.id)
    .eq("active", true)
    .maybeSingle();

  if (goalError) {
    err("goal lookup failed:", goalError.message);
    return;
  }

  if (!goal) return;

  const delta = isJoin ? 1 : isLeave ? -1 : 0;
  const nextCount = Math.max(Number(goal.last_count || 0) + delta, 0);
  const reached = nextCount >= goal.target_count;
  const now = new Date().toISOString();

  await supabase
    .from("subscriber_goals")
    .update({
      last_count: nextCount,
      active: reached ? false : true,
      achieved_at: reached ? now : goal.achieved_at,
      celebration_sent_at: reached ? now : goal.celebration_sent_at,
      channel_title: channel.title,
      channel_username: channel.username || null,
      updated_at: now,
    })
    .eq("id", goal.id);

  if (reached) {
    await sendMessage(admin.user_id, goalMessage(goal, channel, nextCount));

    if (GOAL_CELEBRATION_GIF_URL) {
      await sendAnimation(
        admin.user_id,
        GOAL_CELEBRATION_GIF_URL,
        `🎉 ${escapeHtml(channel.title)} reached ${goal.target_count} subscribers!`
      );
    }

    return;
  }

  await sendMessage(admin.user_id, goalMessage(goal, channel, nextCount));
}

module.exports = {
  renderProgressBar,
  goalMessage,
  handleGoalProgress,
};
