const { supabase, GOAL_CELEBRATION_GIF_URL } = require("../config");
const { channelDisplay, escapeHtml } = require("../utils/helpers");
const { sendMessage, sendAnimation } = require("./telegram");
const { err } = require("../utils/logger");

function goalMessage(goal, channel, count) {
  const remaining = Math.max(goal.target_count - count, 0);

  if (!remaining) {
    return `🎉 <b>Subscriber Goal Reached!</b>

${channelDisplay(channel)}
Goal: <b>${goal.target_count}</b>
Current: <b>${count}</b>`;
  }

  return `🎯 <b>Subscriber Goal Progress</b>

${channelDisplay(channel)}
Goal: <b>${goal.target_count}</b>
Current: <b>${count}</b>
Remaining: <b>${remaining}</b>`;
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
  goalMessage,
  handleGoalProgress,
};
