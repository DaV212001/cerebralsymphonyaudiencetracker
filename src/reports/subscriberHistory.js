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

module.exports = {
  buildSubscriberHistoryReport,
  buildRejoinersReport,
};
