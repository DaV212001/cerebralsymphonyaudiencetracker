const { ADMIN_USER_ID, supabase } = require("../config");
const {
  sendMessage,
  sendTrackedMessage,
  editTrackedMessage,
  getChannelMemberCount,
  getChatMember,
} = require("../services/telegram");
const { invalidateChannelAdminsCache } = require("../services/cache");
const { goalMessage } = require("../services/goals");
const {
  buildSubscriberHistoryReport,
  buildRejoinersReport,
  buildPreExistingMemberReport,
} = require("../reports/subscriberHistory");
const {
  escapeHtml,
  adminSettings,
  notificationMode,
  channelDisplay,
  broadcastBody,
  adminCommandLines,
  batchMode,
  parseBatchWindow,
  wait,
} = require("../utils/helpers");
const { err } = require("../utils/logger");

async function handleCommand(msg, user) {
  // ----------------------
  // START
  // ----------------------
  if (msg === "/start") {
    await supabase.from("users").upsert({
      id: user.id,
      username: user.username || user.first_name,
    });

    return sendMessage(
      user.id,
`👋 <b>Welcome to ChannelSubTracker</b>

📊 <b>What this bot does:</b>
• Tracks channel joins
• Tracks channel leaves
• Sends real-time alerts
• Tracks subscriber goals
• Stores event history reliably

━━━━━━━━━━━━━━
⚙️ <b>Setup Instructions:</b>

1️⃣ Add this bot as an <b>ADMIN</b> in your channel  
2️⃣ Enable <b>"View Members"</b> permission  
3️⃣ Send /channels to confirm connection  

━━━━━━━━━━━━━━
📌 <b>Commands:</b>

/channels — view your channels  
/history &lt;@user|id&gt; [channel_id] — view subscriber lifecycle dossier  
/rejoiners [channel_id] — view repeat/re-joining subscribers  
/settings &lt;channel_id&gt; — view channel notification settings  
/notify &lt;channel_id&gt; all|joins|leaves — choose alerts  
/hideuser &lt;channel_id&gt; on|off — hide or show usernames  
/batch &lt;channel_id&gt; off|30s|1m|5m — batch rapid alerts  
/goal &lt;channel_id&gt; &lt;target_count&gt; — set subscriber goal  
/goalstatus &lt;channel_id&gt; — view subscriber goal  
/goaloff &lt;channel_id&gt; — clear subscriber goal${adminCommandLines(user)}  
/help — show help menu  
/unsubscribe &lt;channel_id&gt; — stop tracking  

━━━━━━━━━━━━━━
⚡ <i>Once added, tracking starts automatically.</i>`
    );
  }

  // ----------------------
  // HELP
  // ----------------------
  if (msg === "/help") {
    return sendMessage(
      user.id,
`📘 <b>Help Menu</b>

━━━━━━━━━━━━━━
📊 <b>Features:</b>
• Real-time join/leave tracking  
• Automatic event logging  
• Reliable retry system (no missed events)  
• Choose all alerts, joins only, or leaves only  
• Hide joiner/leaver usernames in notifications  
• Batch rapid activity into summary notifications  
• Set subscriber goals and celebrate milestones  

━━━━━━━━━━━━━━
⚙️ <b>How to Use:</b>

1. Add bot as admin in your channel  
2. Enable <b>"View Members"</b>  
3. Use /channels to verify  

━━━━━━━━━━━━━━
📌 <b>Commands:</b>

/start — setup instructions  
/channels — list your channels  
/history &lt;@user|id&gt; [channel_id] — view subscriber lifecycle dossier  
/rejoiners [channel_id] — view repeat/re-joining subscribers  
/settings &lt;channel_id&gt; — view notification settings  
/notify &lt;channel_id&gt; all|joins|leaves — choose alerts  
/hideuser &lt;channel_id&gt; on|off — hide or show usernames  
/batch &lt;channel_id&gt; off|30s|1m|5m — batch rapid alerts  
/goal &lt;channel_id&gt; &lt;target_count&gt; — set subscriber goal  
/goalstatus &lt;channel_id&gt; — view subscriber goal  
/goaloff &lt;channel_id&gt; — clear subscriber goal${adminCommandLines(user)}  
/unsubscribe &lt;channel_id&gt; — stop tracking  
/help — show this menu  

━━━━━━━━━━━━━━
🧠 <i>Tip:</i>  
Use the channel ID from /channels when unsubscribing.`
    );
  }

  // ----------------------
  // BROADCAST (Superadmin)
  // ----------------------
  if (msg.startsWith("/broadcast")) {
    if (!ADMIN_USER_ID || user.id !== ADMIN_USER_ID) {
      return sendMessage(user.id, "❌ You are not allowed to use this command.");
    }

    const text = msg.replace(/^\/broadcast(@\w+)?\s*/i, "").trim();

    if (!text) {
      return sendMessage(user.id, "❌ Usage: /broadcast &lt;message&gt;");
    }

    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id");

    if (usersError) {
      err("broadcast users lookup failed:", usersError.message);
      return sendMessage(user.id, "❌ Could not load users for broadcast.");
    }

    const { data: broadcast, error: broadcastError } = await supabase
      .from("broadcasts")
      .insert({
        admin_user_id: user.id,
        text,
        header: "Update from ChannelSubTracker",
      })
      .select("id")
      .single();

    if (broadcastError || !broadcast) {
      err("broadcast create failed:", broadcastError?.message);
      return sendMessage(user.id, "❌ Could not create broadcast record.");
    }

    let sent = 0;
    let failed = 0;
    const broadcastText = broadcastBody(text);

    for (const target of users || []) {
      try {
        const result = await sendTrackedMessage(target.id, broadcastText);
        const status = result.ok && result.messageId ? "sent" : "failed";

        if (status === "sent") {
          sent += 1;
        } else {
          failed += 1;
        }

        const { error: messageInsertError } = await supabase
          .from("broadcast_messages")
          .insert({
            broadcast_id: broadcast.id,
            user_id: target.id,
            message_id: result.messageId || null,
            status,
            error: result.error || null,
          });

        if (messageInsertError) {
          err("broadcast message log failed:", messageInsertError.message);
        }

        await wait(80);
      } catch (e) {
        failed += 1;
        err("broadcast failed:", target.id, e.message);
      }
    }

    return sendMessage(
      user.id,
      `✅ Broadcast #${broadcast.id} complete.\nSent: ${sent}\nFailed: ${failed}\n\nEdit later with:\n/editbroadcast ${broadcast.id} &lt;new message&gt;`
    );
  }

  // ----------------------
  // EDIT BROADCAST (Superadmin)
  // ----------------------
  if (msg.startsWith("/editbroadcast")) {
    if (!ADMIN_USER_ID || user.id !== ADMIN_USER_ID) {
      return sendMessage(user.id, "❌ You are not allowed to use this command.");
    }

    const match = msg.match(/^\/editbroadcast(?:@\w+)?\s+(\d+)\s+([\s\S]+)/i);

    if (!match) {
      return sendMessage(
        user.id,
        "❌ Usage: /editbroadcast &lt;broadcast_id&gt; &lt;message&gt;"
      );
    }

    const broadcastId = Number(match[1]);
    const text = match[2].trim();

    if (!text) {
      return sendMessage(
        user.id,
        "❌ Usage: /editbroadcast &lt;broadcast_id&gt; &lt;message&gt;"
      );
    }

    const { data: messages, error: messagesError } = await supabase
      .from("broadcast_messages")
      .select("id, user_id, message_id")
      .eq("broadcast_id", broadcastId)
      .in("status", ["sent", "edited", "edit_failed"]);

    if (messagesError) {
      err("broadcast edit lookup failed:", messagesError.message);
      return sendMessage(user.id, "❌ Could not load broadcast messages.");
    }

    if (!messages?.length) {
      return sendMessage(
        user.id,
        "❌ No editable messages found for that broadcast."
      );
    }

    let edited = 0;
    let failed = 0;
    const nextText = broadcastBody(text);

    for (const message of messages) {
      const result = await editTrackedMessage(
        message.user_id,
        message.message_id,
        nextText
      );

      const { error: updateError } = await supabase
        .from("broadcast_messages")
        .update({
          status: result.ok ? "edited" : "edit_failed",
          error: result.error || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", message.id);

      if (updateError) {
        err("broadcast message edit log failed:", updateError.message);
      }

      if (result.ok) {
        edited += 1;
      } else {
        failed += 1;
      }

      await wait(80);
    }

    await supabase
      .from("broadcasts")
      .update({
        text,
        edited_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", broadcastId);

    return sendMessage(
      user.id,
      `✅ Broadcast #${broadcastId} edit complete.\nEdited: ${edited}\nFailed: ${failed}`
    );
  }

  // ----------------------
  // CHANNELS LIST
  // ----------------------
  if (msg === "/channels") {
    const { data } = await supabase
      .from("channel_admins")
      .select(
        "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)"
      )
      .eq("user_id", user.id);

    if (!data?.length) {
      return sendMessage(user.id, "📭 No channels connected.");
    }

    let out = "📺 <b>Your Channels</b>\n\n";

    for (const c of data) {
      const ch = c.channels;

      const display = ch?.username
        ? `<a href="https://t.me/${ch.username}">${escapeHtml(ch.title)}</a>`
        : `<b>${escapeHtml(ch?.title || "Unknown")}</b>`;

      const settings = adminSettings(c);
      const usernameMode = settings.hide_usernames ? "hidden" : "visible";

      out += `• ${display}\n<code>${c.channel_id}</code>\nAlerts: ${notificationMode(settings)}\nUsernames: ${usernameMode}\nBatching: ${batchMode(settings)}\n\n`;
    }

    return sendMessage(user.id, out);
  }

  // ----------------------
  // SETTINGS
  // ----------------------
  if (msg.startsWith("/settings")) {
    const channelId = msg.split(/\s+/)[1];

    if (!channelId) {
      return sendMessage(user.id, "❌ Usage: /settings &lt;channel_id&gt;");
    }

    const { data: row, error: settingsError } = await supabase
      .from("channel_admins")
      .select(
        "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)"
      )
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .single();

    if (settingsError || !row) {
      return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
    }

    const settings = adminSettings(row);
    return sendMessage(
      user.id,
`⚙️ <b>Notification Settings</b>

📢 ${channelDisplay(row.channels)}
🆔 Channel ID: <code>${row.channel_id}</code>

Alerts: <b>${notificationMode(settings)}</b>
Usernames: <b>${settings.hide_usernames ? "hidden" : "visible"}</b>
Batching: <b>${batchMode(settings)}</b>

Commands:
/notify ${row.channel_id} all
/notify ${row.channel_id} joins
/notify ${row.channel_id} leaves
/hideuser ${row.channel_id} on
/hideuser ${row.channel_id} off
/batch ${row.channel_id} off
/batch ${row.channel_id} 1m
/goal ${row.channel_id} 1000
/goalstatus ${row.channel_id}
/goaloff ${row.channel_id}`
    );
  }

  // ----------------------
  // NOTIFY TOGGLE
  // ----------------------
  if (msg.startsWith("/notify")) {
    const [, channelId, mode] = msg.split(/\s+/);
    const allowedModes = new Set(["all", "joins", "leaves"]);

    if (!channelId || !allowedModes.has(mode)) {
      return sendMessage(
        user.id,
        "❌ Usage: /notify &lt;channel_id&gt; all|joins|leaves"
      );
    }

    const nextSettings = {
      notify_joins: mode !== "leaves",
      notify_leaves: mode !== "joins",
    };

    const { data, error: updateError } = await supabase
      .from("channel_admins")
      .update(nextSettings)
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .select(
        "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)"
      )
      .single();

    if (updateError || !data) {
      return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
    }

    invalidateChannelAdminsCache(channelId);
    const settings = adminSettings(data);
    return sendMessage(
      user.id,
      `✅ Alerts for ${channelDisplay(data.channels)} set to <b>${notificationMode(settings)}</b>.`
    );
  }

  // ----------------------
  // HIDE USERNAME TOGGLE
  // ----------------------
  if (msg.startsWith("/hideuser")) {
    const [, channelId, mode] = msg.split(/\s+/);
    const allowedModes = new Set(["on", "off"]);

    if (!channelId || !allowedModes.has(mode)) {
      return sendMessage(user.id, "❌ Usage: /hideuser &lt;channel_id&gt; on|off");
    }

    const { data, error: updateError } = await supabase
      .from("channel_admins")
      .update({ hide_usernames: mode === "on" })
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .select(
        "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)"
      )
      .single();

    if (updateError || !data) {
      return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
    }

    invalidateChannelAdminsCache(channelId);
    const settings = adminSettings(data);
    return sendMessage(
      user.id,
      `✅ Usernames for ${channelDisplay(data.channels)} are now <b>${settings.hide_usernames ? "hidden" : "visible"}</b>.`
    );
  }

  // ----------------------
  // BATCH ALERT SETTING
  // ----------------------
  if (msg.startsWith("/batch")) {
    const [, channelId, windowValue] = msg.split(/\s+/);
    const seconds = parseBatchWindow(windowValue);

    if (!channelId || seconds === null) {
      return sendMessage(
        user.id,
        "❌ Usage: /batch &lt;channel_id&gt; off|30s|1m|5m"
      );
    }

    const { data, error: updateError } = await supabase
      .from("channel_admins")
      .update({ batch_window_seconds: seconds })
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .select(
        "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(title, username)"
      )
      .single();

    if (updateError || !data) {
      return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
    }

    invalidateChannelAdminsCache(channelId);
    const settings = adminSettings(data);
    return sendMessage(
      user.id,
      `✅ Batching for ${channelDisplay(data.channels)} set to <b>${batchMode(settings)}</b>.`
    );
  }

  // ----------------------
  // GOAL STATUS
  // ----------------------
  if (msg.startsWith("/goalstatus")) {
    const channelId = msg.split(/\s+/)[1];

    if (!channelId) {
      return sendMessage(user.id, "❌ Usage: /goalstatus &lt;channel_id&gt;");
    }

    const { data: goal, error: goalError } = await supabase
      .from("subscriber_goals")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .eq("active", true)
      .maybeSingle();

    if (goalError) {
      err("goal status lookup failed:", goalError.message);
      return sendMessage(user.id, "❌ Could not load subscriber goal.");
    }

    if (!goal) {
      return sendMessage(user.id, "📭 No active subscriber goal for that channel.");
    }

    return sendMessage(
      user.id,
      goalMessage(
        goal,
        { title: goal.channel_title, username: goal.channel_username },
        goal.last_count
      )
    );
  }

  // ----------------------
  // GOAL OFF
  // ----------------------
  if (msg.startsWith("/goaloff")) {
    const channelId = msg.split(/\s+/)[1];

    if (!channelId) {
      return sendMessage(user.id, "❌ Usage: /goaloff &lt;channel_id&gt;");
    }

    const { error: clearError } = await supabase
      .from("subscriber_goals")
      .update({
        active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .eq("active", true);

    if (clearError) {
      err("goal clear failed:", clearError.message);
      return sendMessage(user.id, "❌ Could not clear subscriber goal.");
    }

    return sendMessage(user.id, "✅ Subscriber goal cleared.");
  }

  // ----------------------
  // SET GOAL
  // ----------------------
  if (msg.startsWith("/goal")) {
    const [, channelId, targetValue] = msg.split(/\s+/);
    const targetCount = Number(targetValue);

    if (!channelId || !Number.isInteger(targetCount) || targetCount < 1) {
      return sendMessage(
        user.id,
        "❌ Usage: /goal &lt;channel_id&gt; &lt;target_count&gt;"
      );
    }

    const { data: channelAdmin, error: channelError } = await supabase
      .from("channel_admins")
      .select("channel_id, channels(title, username)")
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .single();

    if (channelError || !channelAdmin) {
      return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
    }

    let currentCount;
    try {
      currentCount = await getChannelMemberCount(channelId);
    } catch (e) {
      err("member count lookup failed:", e.response?.data || e.message);
      return sendMessage(
        user.id,
        "❌ Could not read the channel member count. Make sure the bot is still an admin."
      );
    }

    if (targetCount <= currentCount) {
      return sendMessage(
        user.id,
        `❌ Target must be above the current count (${currentCount}).`
      );
    }

    const channel = channelAdmin.channels || {};
    const now = new Date().toISOString();

    await supabase
      .from("subscriber_goals")
      .update({ active: false, updated_at: now })
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .eq("active", true);

    const { data: goal, error: goalError } = await supabase
      .from("subscriber_goals")
      .insert({
        user_id: user.id,
        channel_id: channelId,
        target_count: targetCount,
        last_count: currentCount,
        active: true,
        channel_title: channel.title || "Channel",
        channel_username: channel.username || null,
      })
      .select("*")
      .single();

    if (goalError || !goal) {
      err("goal create failed:", goalError?.message);
      return sendMessage(user.id, "❌ Could not create subscriber goal.");
    }

    return sendMessage(
      user.id,
      `✅ Subscriber goal set.\n\n${goalMessage(goal, channel, currentCount)}`
    );
  }

  // ----------------------
  // UNSUBSCRIBE
  // ----------------------
  if (msg.startsWith("/unsubscribe")) {
    const channelId = msg.split(" ")[1];

    if (!channelId) {
      return sendMessage(user.id, "❌ Usage: /unsubscribe &lt;channel_id&gt;");
    }

    const { data: ch } = await supabase
      .from("channels")
      .select("title, username")
      .eq("id", channelId)
      .single();

    const link = ch?.username
      ? `<a href="https://t.me/${ch.username}">${escapeHtml(ch.title)}</a>`
      : `<b>${escapeHtml(ch?.title || "Channel")}</b>`;

    await supabase
      .from("channel_admins")
      .delete()
      .eq("user_id", user.id)
      .eq("channel_id", channelId);

    invalidateChannelAdminsCache(channelId);

    return sendMessage(user.id, `🛑 Unsubscribed from ${link}`);
  }

  // ----------------------
  // SUBSCRIBER HISTORY / AUDIT
  // ----------------------
  if (msg.startsWith("/history") || msg.startsWith("/audit")) {
    const parts = msg.trim().split(/\s+/);
    const target = parts[1];
    const explicitChannelId = parts[2];

    if (!target) {
      return sendMessage(
        user.id,
        "❌ Usage: /history &lt;@username | user_id&gt; [channel_id]\n\nExample: <code>/history @username</code>"
      );
    }

    const isSuperadmin = ADMIN_USER_ID && user.id === ADMIN_USER_ID;

    const { data: adminChannels, error: adminChannelsError } = await supabase
      .from("channel_admins")
      .select("channel_id, channels(title, username)")
      .eq("user_id", user.id);

    let channelsToSearch = adminChannels || [];

    // Superadmin fallback if not explicitly subscribed in channel_admins
    if (isSuperadmin && (!channelsToSearch.length || explicitChannelId)) {
      if (explicitChannelId) {
        const { data: ch } = await supabase
          .from("channels")
          .select("id, title, username")
          .eq("id", explicitChannelId)
          .maybeSingle();
        if (ch) {
          channelsToSearch = [{ channel_id: ch.id, channels: ch }];
        }
      } else {
        const { data: allChannels } = await supabase
          .from("channels")
          .select("id, title, username");
        channelsToSearch = (allChannels || []).map((c) => ({
          channel_id: c.id,
          channels: c,
        }));
      }
    } else if (explicitChannelId) {
      const found = channelsToSearch.find(
        (c) => String(c.channel_id) === String(explicitChannelId)
      );
      if (!found) {
        return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
      }
      channelsToSearch = [found];
    }

    if (!channelsToSearch.length) {
      return sendMessage(
        user.id,
        "📭 No channels connected to your account. Use /channels to verify your registered channels."
      );
    }

    const clean = target.replace(/^@/, "").trim();
    const isNumeric = /^-?\d+$/.test(clean) && !target.startsWith("@");

    // Attempt to resolve cross-event user_id or username to ensure 100% backwards compatibility
    let resolvedUserId = isNumeric ? Number(clean) : null;
    let resolvedUsername = !isNumeric ? clean : null;

    if (!resolvedUserId) {
      const { data: matchedEvents } = await supabase
        .from("events")
        .select("user_id, username")
        .or(`username.ilike.${clean},username.ilike.@${clean}`)
        .not("user_id", "is", null)
        .limit(1);

      if (matchedEvents?.length) {
        resolvedUserId = matchedEvents[0].user_id;
      }
    }

    if (resolvedUserId && !resolvedUsername) {
      const { data: matchedEvents } = await supabase
        .from("events")
        .select("username")
        .eq("user_id", resolvedUserId)
        .not("username", "is", null)
        .limit(1);

      if (matchedEvents?.length && matchedEvents[0].username) {
        resolvedUsername = matchedEvents[0].username.replace(/^@/, "");
      }
    }

    // Build flexible OR filter that matches across all legacy and current formats
    const orConditions = [`username.ilike.${clean}`, `username.ilike.@${clean}`];
    if (resolvedUserId) {
      orConditions.push(`user_id.eq.${resolvedUserId}`);
    }
    if (isNumeric) {
      orConditions.push(`user_id.eq.${clean}`);
    }
    if (resolvedUsername && resolvedUsername.toLowerCase() !== clean.toLowerCase()) {
      orConditions.push(`username.ilike.${resolvedUsername}`);
      orConditions.push(`username.ilike.@${resolvedUsername}`);
    }

    const orFilter = orConditions.join(",");
    let reportsSent = 0;

    for (const ch of channelsToSearch) {
      const { data: events, error: eventsError } = await supabase
        .from("events")
        .select("*")
        .eq("channel_id", ch.channel_id)
        .or(orFilter)
        .order("created_at", { ascending: true });

      if (eventsError) {
        err("history query failed:", eventsError.message);
        continue;
      }

      if (events?.length) {
        const report = buildSubscriberHistoryReport(
          target,
          ch.channels || { title: "Channel" },
          events
        );
        await sendMessage(user.id, report);
        reportsSent += 1;
      } else if (resolvedUserId) {
        // Fallback: check live Telegram status for founding/pre-existing members who never left
        const liveMember = await getChatMember(ch.channel_id, resolvedUserId);
        if (
          liveMember &&
          ["member", "administrator", "creator"].includes(liveMember.status)
        ) {
          const { data: otherEvents } = await supabase
            .from("events")
            .select("channel_id, created_at, channels(title)")
            .eq("user_id", resolvedUserId)
            .neq("channel_id", ch.channel_id)
            .eq("event_type", "JOIN");

          const report = buildPreExistingMemberReport(
            target,
            ch.channels || { title: "Channel" },
            liveMember,
            otherEvents || []
          );
          await sendMessage(user.id, report);
          reportsSent += 1;
        }
      }
    }

    if (reportsSent === 0) {
      return sendMessage(
        user.id,
        `📭 No recorded join/leave history found for <b>${escapeHtml(
          target
        )}</b> in your channel(s).\n\n<i>Note: Telegram only sends events when members join or leave while the bot is active. Members who joined before tracking began and have never left have no churn events recorded.</i>`
      );
    }

    return;
  }

  // ----------------------
  // REJOINERS
  // ----------------------
  if (msg.startsWith("/rejoiners")) {
    const parts = msg.trim().split(/\s+/);
    const explicitChannelId = parts[1];

    const { data: adminChannels, error: adminChannelsError } = await supabase
      .from("channel_admins")
      .select("channel_id, channels(title, username)")
      .eq("user_id", user.id);

    if (adminChannelsError || !adminChannels?.length) {
      return sendMessage(user.id, "📭 No channels connected to your account.");
    }

    let targetChannel = adminChannels[0];
    if (explicitChannelId) {
      const found = adminChannels.find(
        (c) => String(c.channel_id) === String(explicitChannelId)
      );
      if (!found) {
        return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
      }
      targetChannel = found;
    } else if (adminChannels.length > 1) {
      return sendMessage(
        user.id,
        `❌ You have multiple channels. Please specify channel ID:\n/rejoiners &lt;channel_id&gt;\n\nYour channels:\n` +
          adminChannels
            .map(
              (c) =>
                `• ${escapeHtml(c.channels?.title || "Channel")}: <code>${c.channel_id}</code>`
            )
            .join("\n")
      );
    }

    const { data: events, error: eventsError } = await supabase
      .from("events")
      .select("user_id, username, event_type, created_at, event_time")
      .eq("channel_id", targetChannel.channel_id)
      .order("created_at", { ascending: true });

    if (eventsError) {
      err("rejoiners query failed:", eventsError.message);
      return sendMessage(user.id, "❌ Could not load channel events.");
    }

    const report = buildRejoinersReport(
      targetChannel.channels || { title: "Channel" },
      events || []
    );
    return sendMessage(user.id, report);
  }
}

module.exports = {
  handleCommand,
};
