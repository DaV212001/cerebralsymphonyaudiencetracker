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
  buildDashboardView,
  buildChannelsListView,
  buildGoalDetailView,
  buildRejoinersDetailView,
} = require("../views/dashboard");
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

📊 <b>Core Capabilities:</b>
• <b>Real-time Alerts:</b> Instant notifications for joins & leaves with quick action buttons
• <b>Interactive Dashboard:</b> 1-tap toggles for alerts, username privacy, and batching
• <b>Subscriber Lifecycle Dossier:</b> Track member stints, join dates, and cumulative tenure
• <b>Churn & Re-joiners:</b> Detect returning subscribers & churn cycles
• <b>Milestone Goals:</b> Live Unicode progress bars and milestone celebrations

━━━━━━━━━━━━━━
⚙️ <b>Quick Setup:</b>
1️⃣ Add this bot as an <b>ADMIN</b> in your Telegram channel  
2️⃣ Enable <b>"View Members"</b> (or "Invite Users via Link")  
3️⃣ Send /channels to open your interactive control dashboard  

━━━━━━━━━━━━━━
📌 <b>Menu Commands:</b>
/channels — interactive channel control dashboard  
/settings [channel_id] — channel configuration & alert toggles  
/history &lt;@user|id&gt; [channel_id] — view subscriber lifecycle dossier  
/rejoiners [channel_id] — view repeat & re-joining members  
/backfill &lt;@user|id&gt; &lt;channel_id&gt; &lt;YYYY-MM-DD&gt; — backfill join date  
/goal &lt;channel_id&gt; &lt;target_count&gt; — set subscriber milestone goal  
/goalstatus [channel_id] — view visual progress bar  
/goaloff [channel_id] — clear subscriber goal${adminCommandLines(user)}  
/notify &lt;channel_id&gt; all|joins|leaves — choose alert types  
/hideuser &lt;channel_id&gt; on|off — toggle username privacy  
/batch &lt;channel_id&gt; off|30s|1m|5m — batch rapid notifications  
/unsubscribe &lt;channel_id&gt; — stop tracking channel  
/help — show documentation & guide  

━━━━━━━━━━━━━━
⚡ <i>Tip: Send /channels to open the 1-tap control dashboard.</i>`
    );
  }

  // ----------------------
  // HELP (Documentation & Setup Guide)
  // ----------------------
  if (msg === "/help") {
    return sendMessage(
      user.id,
`📖 <b>ChannelSubTracker — Documentation & Setup Guide</b>

━━━━━━━━━━━━━━
🛠 <b>Step-by-Step Setup Guide:</b>

1️⃣ <b>Add Bot as Channel Admin:</b>
• Open your Telegram Channel settings ➔ <b>Administrators</b> ➔ <b>Add Administrator</b>.
• Search for <code>@channelsubcribertrackerbot</code> and add it.

2️⃣ <b>Grant Permissions:</b>
• Enable <b>"View Members"</b> (or "Invite Users via Link").
• <i>(Telegram requires this permission so it can dispatch join & leave events to the bot.)</i>

3️⃣ <b>Confirm Connection:</b>
• Return to this chat and send <b>/channels</b>.
• You will immediately see your channel with its interactive <b>Control Dashboard</b>.

━━━━━━━━━━━━━━
🎛 <b>Configuring Your Notifications:</b>

Send <b>/channels</b> or <b>/settings</b> to open the 1-tap dashboard:
• 🔔 <b>Alerts Mode:</b> Cycle between <code>All Activity</code> ➔ <code>Joins Only</code> ➔ <code>Leaves Only</code> ➔ <code>Muted</code>.
• 👤 <b>Username Privacy:</b> Toggle between <code>Visible 👁</code> and <code>Hidden 🙈</code> (anonymizes user names in alerts).
• ⏱ <b>Batching Window:</b> Cycle between <code>Instant ⚡</code>, <code>30s</code>, <code>1m</code>, and <code>5m</code> (groups rapid activity into a single summary).

━━━━━━━━━━━━━━
👥 <b>Subscriber Auditing & Dossiers:</b>

• <b>One-Tap Dossier:</b> Whenever a join or leave alert arrives, tap <b>[ 👤 Member Dossier ]</b> to see their tenure, join date, and return history.
• <b>Manual Audit:</b>
  <code>/history @username</code> — view lifecycle history across your channels.
  <code>/history 123456789 -1002075016349</code> — audit by numeric User ID.
• <b>Repeat Joiners:</b>
  <code>/rejoiners [channel_id]</code> — see members who have left and returned.
• <b>Backfill Founding Members:</b>
  If a member joined before the bot was added:
  <code>/backfill @username &lt;channel_id&gt; YYYY-MM-DD [HH:mm]</code>

━━━━━━━━━━━━━━
🎯 <b>Subscriber Milestone Goals:</b>

• <b>Set a Goal:</b> <code>/goal &lt;channel_id&gt; &lt;target&gt;</code> (e.g. <code>/goal -1002075016349 1000</code>).
• <b>View Visual Progress:</b> Send <code>/goalstatus</code> to view the live Unicode progress bar <code>[████████░░░░] 74.2%</code>.
• <b>Clear Goal:</b> Send <code>/goaloff</code>.

━━━━━━━━━━━━━━
📌 <b>Command Reference:</b>
/channels — interactive channel control dashboard
/settings [channel_id] — view/edit channel alert settings
/history &lt;@user|id&gt; [channel_id] — member lifecycle dossier
/rejoiners [channel_id] — repeat & returning subscriber report
/backfill &lt;@user|id&gt; &lt;channel_id&gt; &lt;YYYY-MM-DD&gt; — backfill join date
/goal &lt;channel_id&gt; &lt;target_count&gt; — set subscriber milestone goal
/goalstatus [channel_id] — view live goal progress bar
/goaloff [channel_id] — clear active subscriber goal${adminCommandLines(user)}
/notify &lt;channel_id&gt; all|joins|leaves — set alerts mode via command
/hideuser &lt;channel_id&gt; on|off — toggle username privacy via command
/batch &lt;channel_id&gt; off|30s|1m|5m — batch rapid notifications via command
/unsubscribe &lt;channel_id&gt; — disconnect bot from tracking a channel
/start — welcome message & quick links
/help — show this documentation & setup guide`
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
  // RESUME BROADCAST (Superadmin)
  // ----------------------
  if (msg.startsWith("/resumebroadcast")) {
    if (!ADMIN_USER_ID || user.id !== ADMIN_USER_ID) {
      return sendMessage(user.id, "❌ You are not allowed to use this command.");
    }

    const parts = msg.trim().split(/\s+/);
    let broadcastId = parts[1] ? Number(parts[1]) : null;

    if (!broadcastId) {
      const { data: latest } = await supabase
        .from("broadcasts")
        .select("id, text")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!latest) {
        return sendMessage(user.id, "❌ No previous broadcasts found to resume.");
      }
      broadcastId = latest.id;
    }

    const { data: broadcast, error: broadcastError } = await supabase
      .from("broadcasts")
      .select("*")
      .eq("id", broadcastId)
      .maybeSingle();

    if (broadcastError || !broadcast) {
      return sendMessage(user.id, `❌ Broadcast #${broadcastId} not found.`);
    }

    const { data: users } = await supabase.from("users").select("id");
    const { data: sentMessages } = await supabase
      .from("broadcast_messages")
      .select("user_id")
      .eq("broadcast_id", broadcastId)
      .eq("status", "sent");

    const sentSet = new Set((sentMessages || []).map((m) => m.user_id));
    const pendingUsers = (users || []).filter((u) => !sentSet.has(u.id));

    if (!pendingUsers.length) {
      return sendMessage(
        user.id,
        `✅ Broadcast #${broadcastId} has already been sent to all registered users! (Total delivered: ${sentSet.size})`
      );
    }

    await sendMessage(
      user.id,
      `⏳ Resuming Broadcast #${broadcastId} for ${pendingUsers.length} remaining users (skipping ${sentSet.size} already sent)...`
    );

    let sent = 0;
    let failed = 0;
    const broadcastText = broadcastBody(broadcast.text);

    for (const target of pendingUsers) {
      try {
        const result = await sendTrackedMessage(target.id, broadcastText);
        const status = result.ok && result.messageId ? "sent" : "failed";

        if (status === "sent") {
          sent += 1;
        } else {
          failed += 1;
        }

        await supabase
          .from("broadcast_messages")
          .upsert({
            broadcast_id: broadcastId,
            user_id: target.id,
            message_id: result.messageId || null,
            status,
            error: result.error || null,
          });

        await wait(80);
      } catch (e) {
        failed += 1;
        err("resume broadcast failed:", target.id, e.message);
      }
    }

    return sendMessage(
      user.id,
      `✅ Broadcast #${broadcastId} resume complete.\nNewly Sent: ${sent}\nFailed (unstarted/blocked): ${failed}\nTotal Delivered: ${sentSet.size + sent}/${users.length}`
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
  // CHANNELS LIST & DASHBOARD
  // ----------------------
  if (msg === "/channels") {
    const { data } = await supabase
      .from("channel_admins")
      .select(
        "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(id, title, username)"
      )
      .eq("user_id", user.id);

    if (!data?.length) {
      return sendMessage(
        user.id,
        "📭 No channels connected.\n\nAdd this bot as an ADMIN to your channel with 'View Members' permission to begin tracking."
      );
    }

    if (data.length === 1) {
      const channelId = data[0].channel_id;
      const { data: activeGoal } = await supabase
        .from("subscriber_goals")
        .select("*")
        .eq("user_id", user.id)
        .eq("channel_id", channelId)
        .eq("active", true)
        .maybeSingle();

      const view = buildDashboardView(data[0], activeGoal);
      return sendMessage(user.id, view.text, { reply_markup: view.reply_markup });
    }

    const view = buildChannelsListView(data);
    return sendMessage(user.id, view.text, { reply_markup: view.reply_markup });
  }

  // ----------------------
  // SETTINGS & DASHBOARD
  // ----------------------
  if (msg.startsWith("/settings")) {
    const channelId = msg.split(/\s+/)[1];

    if (!channelId) {
      const { data: userChannels } = await supabase
        .from("channel_admins")
        .select(
          "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(id, title, username)"
        )
        .eq("user_id", user.id);

      if (!userChannels?.length) {
        return sendMessage(user.id, "📭 No channels connected.");
      }

      if (userChannels.length === 1) {
        const { data: activeGoal } = await supabase
          .from("subscriber_goals")
          .select("*")
          .eq("user_id", user.id)
          .eq("channel_id", userChannels[0].channel_id)
          .eq("active", true)
          .maybeSingle();

        const view = buildDashboardView(userChannels[0], activeGoal);
        return sendMessage(user.id, view.text, { reply_markup: view.reply_markup });
      }

      const view = buildChannelsListView(userChannels);
      return sendMessage(user.id, view.text, { reply_markup: view.reply_markup });
    }

    const { data: row, error: settingsError } = await supabase
      .from("channel_admins")
      .select(
        "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(id, title, username)"
      )
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .maybeSingle();

    if (settingsError || !row) {
      return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
    }

    const { data: activeGoal } = await supabase
      .from("subscriber_goals")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .eq("active", true)
      .maybeSingle();

    const view = buildDashboardView(row, activeGoal);
    return sendMessage(user.id, view.text, { reply_markup: view.reply_markup });
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
    let channelId = msg.split(/\s+/)[1];

    if (!channelId) {
      const { data: userChannels } = await supabase
        .from("channel_admins")
        .select("channel_id")
        .eq("user_id", user.id);

      if (!userChannels?.length) {
        return sendMessage(user.id, "📭 No channels connected.");
      }

      if (userChannels.length === 1) {
        channelId = userChannels[0].channel_id;
      } else {
        return sendMessage(user.id, "❌ Usage: /goalstatus &lt;channel_id&gt;");
      }
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

    const { data: ch } = await supabase
      .from("channels")
      .select("id, title, username")
      .eq("id", channelId)
      .maybeSingle();

    const view = buildGoalDetailView(goal, ch || { title: "Channel" }, channelId);
    return sendMessage(user.id, view.text, { reply_markup: view.reply_markup });
  }

  // ----------------------
  // GOAL OFF
  // ----------------------
  if (msg.startsWith("/goaloff")) {
    let channelId = msg.split(/\s+/)[1];

    if (!channelId) {
      const { data: userChannels } = await supabase
        .from("channel_admins")
        .select("channel_id")
        .eq("user_id", user.id);

      if (userChannels?.length === 1) {
        channelId = userChannels[0].channel_id;
      } else {
        return sendMessage(user.id, "❌ Usage: /goaloff &lt;channel_id&gt;");
      }
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

    return sendMessage(user.id, "✅ Subscriber goal cleared.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 Channel Dashboard", callback_data: `cb:ch_view:${channelId}` }],
        ],
      },
    });
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

  // ----------------------
  // BACKFILL
  // ----------------------
  if (msg.startsWith("/backfill")) {
    const parts = msg.trim().split(/\s+/);
    const target = parts[1];
    const channelId = parts[2];
    const dateStr = parts[3];
    const timeStr = parts[4] || "00:00";

    if (!target || !channelId || !dateStr) {
      return sendMessage(
        user.id,
        "❌ Usage: /backfill &lt;@username | user_id&gt; &lt;channel_id&gt; &lt;YYYY-MM-DD&gt; [HH:mm]\n\nExample:\n<code>/backfill @username -1002075016349 2026-04-20 23:59</code>"
      );
    }

    const isSuperadmin = ADMIN_USER_ID && user.id === ADMIN_USER_ID;

    const { data: adminRow } = await supabase
      .from("channel_admins")
      .select("channel_id, channels(title, username)")
      .eq("user_id", user.id)
      .eq("channel_id", channelId)
      .maybeSingle();

    if (!adminRow && !isSuperadmin) {
      return sendMessage(user.id, "❌ Channel not found in your subscriptions.");
    }

    const parsedDate = new Date(`${dateStr}T${timeStr}:00Z`);
    if (isNaN(parsedDate.getTime())) {
      return sendMessage(
        user.id,
        "❌ Invalid date format. Please use YYYY-MM-DD (e.g. 2026-04-20)."
      );
    }

    const clean = target.replace(/^@/, "").trim();
    const isNumeric = /^-?\d+$/.test(clean) && !target.startsWith("@");

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

    const isoTime = parsedDate.toISOString();

    const { error: insertError } = await supabase.from("events").insert({
      channel_id: channelId,
      user_id: resolvedUserId || null,
      username: resolvedUsername || clean,
      event_type: "JOIN",
      event_time: isoTime,
      created_at: isoTime,
    });

    if (insertError) {
      err("backfill insert failed:", insertError.message);
      return sendMessage(user.id, "❌ Could not save backfill record.");
    }

    const displayName = resolvedUsername
      ? `@${escapeHtml(resolvedUsername)}`
      : target;
    return sendMessage(
      user.id,
      `✅ <b>Backfilled Join Event!</b>\n\n👤 ${displayName}\n📅 Date: ${parsedDate.toUTCString()}\n📢 Channel ID: <code>${channelId}</code>\n\nRun <code>/history ${target} ${channelId}</code> to view their updated dossier!`
    );
  }
}

module.exports = {
  handleCommand,
};
