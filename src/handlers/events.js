const { supabase } = require("../config");
const {
  escapeHtml,
  safeTime,
  adminSettings,
} = require("../utils/helpers");
const {
  getCachedChannelAdmins,
  invalidateChannelAdminsCache,
} = require("../services/cache");
const { sendMessage } = require("../services/telegram");
const { queueBatchNotification } = require("../services/batches");
const { handleGoalProgress } = require("../services/goals");
const { log, err } = require("../utils/logger");

async function handleMyChatMember(update) {
  const myCm = update.my_chat_member;
  if (!myCm) return;

  const channel = myCm.chat;
  const fromUser = myCm.from;
  const newStatus = myCm.new_chat_member?.status;

  if (newStatus === "administrator") {
    // 1. Ensure channel exists in channels table
    await supabase.from("channels").upsert({
      id: channel.id,
      title: channel.title,
      username: channel.username || null,
    });

    // 2. Ensure user exists in users table
    await supabase.from("users").upsert({
      id: fromUser.id,
      username: fromUser.username || fromUser.first_name,
    });

    // 3. Link the admin who added the bot
    const { data: existingAdmin } = await supabase
      .from("channel_admins")
      .select("channel_id")
      .eq("channel_id", channel.id)
      .eq("user_id", fromUser.id)
      .maybeSingle();

    if (!existingAdmin) {
      const { error: adminErr } = await supabase
        .from("channel_admins")
        .insert({
          channel_id: channel.id,
          user_id: fromUser.id,
        });

      if (adminErr) {
        err("Failed to link channel admin:", adminErr.message);
      } else {
        invalidateChannelAdminsCache(channel.id);
        const link = channel.username
          ? `<a href="https://t.me/${channel.username}">${escapeHtml(
              channel.title
            )}</a>`
          : `<b>${escapeHtml(channel.title)}</b>`;

        await sendMessage(
          fromUser.id,
          `✅ <b>Success!</b> I am now tracking ${link}.\n\nUse /settings ${channel.id} to configure notifications.`
        );
      }
    }
  }
}

async function handleChatMember(update) {
  const cm = update.chat_member;
  if (!cm) return;

  const oldS = cm.old_chat_member?.status;
  const newS = cm.new_chat_member?.status;

  const isJoin =
    ["left", "kicked"].includes(oldS) &&
    ["member", "administrator"].includes(newS);

  const isLeave =
    ["member", "administrator"].includes(oldS) &&
    ["left", "kicked"].includes(newS);

  if (!isJoin && !isLeave) return;

  const channel = cm.chat;
  const u = cm.new_chat_member.user;
  const time = safeTime(cm);

  // ----------------------
  // USER DISPLAY (CONTACT STYLE)
  // ----------------------
  const displayName = escapeHtml(
    u.username ? `${u.username}` : u.first_name || "User"
  );

  const contactLink = u.username
    ? `<a href="https://t.me/${u.username}">${displayName}</a>`
    : `<a href="tg://user?id=${u.id}">${displayName}</a>`;

  // ----------------------
  // CHANNEL LINK
  // ----------------------
  const channelLink = channel.username
    ? `<a href="https://t.me/${channel.username}">${escapeHtml(
        channel.title
      )}</a>`
    : `<b>${escapeHtml(channel.title)}</b>`;

  const admins = await getCachedChannelAdmins(channel.id);

  let priorJoinCount = 0;
  if (isJoin) {
    try {
      let q = supabase
        .from("events")
        .select("*", { count: "exact", head: true })
        .eq("channel_id", channel.id)
        .eq("event_type", "JOIN");

      const orParts = [];
      if (u?.id) orParts.push(`user_id.eq.${u.id}`);
      const rawUser = u?.username || u?.first_name;
      if (rawUser) {
        const cleanU = rawUser.replace(/^@/, "");
        orParts.push(`username.ilike.${cleanU}`);
        orParts.push(`username.ilike.@${cleanU}`);
      }

      if (orParts.length) {
        q = q.or(orParts.join(","));
        const { count } = await q;
        priorJoinCount = count || 0;
      }
    } catch (e) {
      // Non-fatal check
    }
  }

  await Promise.allSettled(
    (admins || []).map(async (a) => {
      const settings = adminSettings(a);

      const shouldNotify = isJoin
        ? settings.notify_joins
        : settings.notify_leaves;

      let notifyPromise;
      if (shouldNotify) {
        if (settings.batch_window_seconds > 0) {
          notifyPromise = queueBatchNotification({
            admin: a,
            settings,
            channel,
            eventType: isJoin ? "JOIN" : "LEAVE",
            time,
          });
        } else {
          const userLine = settings.hide_usernames
            ? isJoin
              ? "A user joined"
              : "A user left"
            : contactLink;

          const eventBadge = isJoin
            ? priorJoinCount > 0
              ? `🔄 RE-JOIN #${priorJoinCount + 1}`
              : "🟢 JOIN"
            : "🔴 LEAVE";

          const userSubline =
            isJoin && priorJoinCount > 0 && !settings.hide_usernames
              ? " <i>(Returning member)</i>"
              : "";

          const message = `
<b>${eventBadge}</b>

👤 ${userLine}${userSubline}
━━━━━━━━━━━━━━
📢 ${channelLink}

🆔 Channel ID: <code>${channel.id}</code>
━━━━━━━━━━━━━━
⏰ ${time.toLocaleString()}
`;
          notifyPromise = sendMessage(a.user_id, message);
        }
      } else {
        notifyPromise = Promise.resolve();
      }

      await Promise.all([
        handleGoalProgress({ admin: a, channel, isJoin, isLeave }).catch(
          (e) => {
            err("goal progress failed:", e.message);
          }
        ),
        notifyPromise,
      ]);
    })
  );

  // DB log
  const { error: eventInsertError } = await supabase.from("events").insert({
    channel_id: channel.id,
    user_id: u.id,
    username: u.username || u.first_name,
    event_type: isJoin ? "JOIN" : "LEAVE",
    event_time: time.toISOString(),
  });

  if (eventInsertError) {
    err("event log insert failed:", eventInsertError.message, {
      channel_id: channel.id,
      user_id: u.id,
      event_type: isJoin ? "JOIN" : "LEAVE",
    });
  }

  log("event:", isJoin ? "JOIN" : "LEAVE", displayName);
}

module.exports = {
  handleMyChatMember,
  handleChatMember,
};
