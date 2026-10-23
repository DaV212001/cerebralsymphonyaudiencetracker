const { escapeHtml, formatDuration, channelDisplay } = require("../utils/helpers");

function buildSubscriberHistoryReport(userTarget, channel, events) {
  let joins = 0;
  let leaves = 0;
  let stints = [];
  let currentJoinTime = null;
  let totalActiveMs = 0;
  const now = Date.now();
  let resolvedUserId = null;
  let resolvedUsername = null;

  for (const e of events) {
    if (e.user_id && !resolvedUserId) resolvedUserId = e.user_id;
    if (e.username && !resolvedUsername) resolvedUsername = e.username;

    const t = new Date(e.event_time || e.created_at).getTime();
    if (e.event_type === "JOIN") {
      joins += 1;
      currentJoinTime = t;
    } else if (e.event_type === "LEAVE") {
      leaves += 1;
      if (currentJoinTime) {
        const stintMs = Math.max(t - currentJoinTime, 0);
        stints.push({
          joinedAt: currentJoinTime,
          leftAt: t,
          durationMs: stintMs,
        });
        totalActiveMs += stintMs;
        currentJoinTime = null;
      }
    }
  }

  const lastEvent = events[events.length - 1];
  const isActive = lastEvent.event_type === "JOIN";
  const firstEvent = events[0];
  const firstSeenTime = new Date(firstEvent.event_time || firstEvent.created_at);

  let currentStintDuration = 0;
  if (isActive && currentJoinTime) {
    currentStintDuration = Math.max(now - currentJoinTime, 0);
    totalActiveMs += currentStintDuration;
  }

  const rejoins = Math.max(joins - 1, 0);
  const displayName = resolvedUsername
    ? `@${escapeHtml(resolvedUsername)}`
    : resolvedUserId
    ? `User ${resolvedUserId}`
    : escapeHtml(userTarget);
  const userIdLine = resolvedUserId
    ? `\n🆔 User ID: <code>${resolvedUserId}</code>`
    : "";

  const recentEvents = [...events].reverse().slice(0, 8);
  const timelineLines = recentEvents
    .map((e) => {
      const t = new Date(e.event_time || e.created_at);
      const dateStr = t.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const timeStr = t.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
      const badge = e.event_type === "JOIN" ? "🟢" : "🔴";
      const label = e.event_type === "JOIN" ? "Joined channel" : "Left channel";
      return `${badge} <b>${dateStr} ${timeStr}</b> — ${label}`;
    })
    .join("\n");

  const lastStintInfo = isActive
    ? `\n• Current Stint: <b>${formatDuration(currentStintDuration)}</b>`
    : stints.length
    ? `\n• Last Stay: <b>${formatDuration(stints[stints.length - 1].durationMs)}</b>`
    : "";

  return `👤 <b>Subscriber Dossier: ${displayName}</b>${userIdLine}
📢 ${channelDisplay(channel)}
━━━━━━━━━━━━━━
📊 <b>Current Status:</b> ${isActive ? "🟢 Active Member" : "🔴 Left / Inactive"}
⏱ <b>Total Time Subscribed:</b> <b>${formatDuration(totalActiveMs)}</b>
📅 <b>First Observed:</b> ${firstSeenTime.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}

🔄 <b>Lifecycle & Loyalty:</b>
• Total Joins: <b>${joins}</b>
• Total Leaves: <b>${leaves}</b>
• Re-joins: <b>${rejoins}</b> ${
    rejoins > 0
      ? "<i>(Returning subscriber)</i>"
      : "<i>(First-time subscriber)</i>"
  }${lastStintInfo}

📜 <b>Recent Activity Timeline:</b>
${timelineLines}`;
}

function buildRejoinersReport(channel, events) {
  const stats = new Map();

  for (const e of events) {
    const key = e.user_id
      ? String(e.user_id)
      : e.username
      ? `@${e.username.toLowerCase()}`
      : null;
    if (!key) continue;

    if (!stats.has(key)) {
      stats.set(key, {
        userId: e.user_id || null,
        username: e.username || null,
        joins: 0,
        leaves: 0,
        lastEvent: e,
      });
    }

    const item = stats.get(key);
    if (e.event_type === "JOIN") item.joins += 1;
    if (e.event_type === "LEAVE") item.leaves += 1;
    if (e.username && !item.username) item.username = e.username;
    item.lastEvent = e;
  }

  const allMembers = Array.from(stats.values());
  const rejoiners = allMembers
    .filter((m) => m.joins > 1)
    .sort((a, b) => b.joins - a.joins);

  if (!rejoiners.length) {
    return `📢 ${channelDisplay(channel)}\n\n✨ <b>No re-joiners detected yet!</b> All recorded subscribers have joined at most once.`;
  }

  const rejoinerRate = ((rejoiners.length / allMembers.length) * 100).toFixed(1);
  const topList = rejoiners
    .slice(0, 10)
    .map((m, idx) => {
      const name = m.username
        ? `@${escapeHtml(m.username)}`
        : `<code>${m.userId}</code>`;
      const status =
        m.lastEvent?.event_type === "JOIN" ? "🟢 active" : "🔴 left";
      return `${idx + 1}. ${name} — <b>${m.joins} joins</b>, ${m.leaves} leaves (${status})`;
    })
    .join("\n");

  return `🔄 <b>Re-joining Subscribers Report</b>\n
📢 ${channelDisplay(channel)}
━━━━━━━━━━━━━━
👥 Unique Tracked Audience: <b>${allMembers.length}</b>
🔁 Returning Subscribers: <b>${rejoiners.length}</b> (${rejoinerRate}% repeat rate)

🏆 <b>Top Serial Re-joiners:</b>
${topList}`;
}

function buildPreExistingMemberReport(
  userTarget,
  channel,
  liveMember,
  otherChannelEvents = []
) {
  if (!liveMember || !liveMember.user) {
    return `👤 <b>Subscriber Dossier: ${escapeHtml(String(userTarget))}</b>
📢 ${channelDisplay(channel)}
━━━━━━━━━━━━━━
ℹ️ <b>No Recorded History</b>

This member has no recorded join/leave events in the database and is not currently detected as an active member in the channel.
<i>(Telegram only dispatches events while the bot is an active admin.)</i>`;
  }

  const u = liveMember.user;
  const displayName = u.username
    ? `@${escapeHtml(u.username)}`
    : escapeHtml(u.first_name || userTarget);
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ");
  const nameLine = fullName ? ` (${escapeHtml(fullName)})` : "";

  let otherChannelsSection = "";
  if (otherChannelEvents.length > 0) {
    const list = otherChannelEvents
      .map((e) => {
        const dateStr = new Date(e.created_at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const chName = e.channels?.title || `Channel ${e.channel_id}`;
        return `• ${escapeHtml(chName)}: Joined on ${dateStr}`;
      })
      .join("\n");
    otherChannelsSection = `\n\n🌐 <b>Activity in Your Other Channels:</b>\n${list}`;
  }

  const role =
    liveMember.status === "creator"
      ? "👑 Channel Owner"
      : liveMember.status === "administrator"
      ? "⭐ Administrator"
      : "🟢 Active Member";

  return `👤 <b>Subscriber Dossier: ${displayName}${nameLine}</b>
🆔 User ID: <code>${u.id}</code>
📢 ${channelDisplay(channel)}
━━━━━━━━━━━━━━
📊 <b>Current Status:</b> ${role} <i>(Verified via live Telegram)</i>

ℹ️ <b>Founding / Pre-Existing Subscriber</b>
This member is currently present in your channel, but joined before the bot began tracking events (or has never unsubscribed). As a result, no join/leave churn transitions exist in the database.${otherChannelsSection}`;
}

module.exports = {
  buildSubscriberHistoryReport,
  buildRejoinersReport,
  buildPreExistingMemberReport,
};
