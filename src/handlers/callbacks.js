const { supabase, ADMIN_USER_ID } = require("../config");
const {
  editMessageText,
  answerCallbackQuery,
  sendMessage,
  getChatMember,
} = require("../services/telegram");
const { invalidateChannelAdminsCache } = require("../services/cache");
const {
  buildDashboardView,
  buildChannelsListView,
  buildGoalDetailView,
  buildRejoinersDetailView,
} = require("../views/dashboard");
const {
  buildSubscriberHistoryReport,
  buildPreExistingMemberReport,
} = require("../reports/subscriberHistory");
const { adminSettings } = require("../utils/helpers");
const { err } = require("../utils/logger");

/**
 * Main callback query router for inline keyboard button clicks.
 * @param {Object} query - Telegram callback_query object
 */
async function handleCallbackQuery(query) {
  const data = query.data;
  const user = query.from;
  const userId = user?.id;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  if (!data || !userId || !chatId) {
    if (query.id) await answerCallbackQuery(query.id);
    return;
  }

  const isSuperadmin = ADMIN_USER_ID && userId === ADMIN_USER_ID;

  try {
    // ----------------------------------------------------
    // 1. ALL CHANNELS LIST (cb:ch_list)
    // ----------------------------------------------------
    if (data === "cb:ch_list") {
      await answerCallbackQuery(query.id);

      const { data: list, error: listError } = await supabase
        .from("channel_admins")
        .select("channel_id, channels(id, title, username)")
        .eq("user_id", userId);

      if (listError) {
        err("cb:ch_list fetch failed:", listError.message);
        return;
      }

      if (!list?.length) {
        return editMessageText(
          chatId,
          messageId,
          "📭 No channels connected to your account."
        );
      }

      const view = buildChannelsListView(list);
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 2. CHANNEL DASHBOARD VIEW & REFRESH (cb:ch_view:<id>, cb:refresh:<id>)
    // ----------------------------------------------------
    if (data.startsWith("cb:ch_view:") || data.startsWith("cb:refresh:")) {
      const isRefresh = data.startsWith("cb:refresh:");
      const channelId = isRefresh
        ? data.slice("cb:refresh:".length)
        : data.slice("cb:ch_view:".length);

      let { data: adminRow } = await supabase
        .from("channel_admins")
        .select(
          "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(id, title, username)"
        )
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .maybeSingle();

      if (!adminRow && isSuperadmin) {
        const { data: ch } = await supabase
          .from("channels")
          .select("id, title, username")
          .eq("id", channelId)
          .maybeSingle();

        if (ch) {
          adminRow = {
            channel_id: ch.id,
            notify_joins: true,
            notify_leaves: true,
            hide_usernames: false,
            batch_window_seconds: 0,
            channels: ch,
          };
        }
      }

      if (!adminRow) {
        return answerCallbackQuery(
          query.id,
          "❌ Channel not found in your subscriptions.",
          true
        );
      }

      const { data: activeGoal } = await supabase
        .from("subscriber_goals")
        .select("*")
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .eq("active", true)
        .maybeSingle();

      await answerCallbackQuery(
        query.id,
        isRefresh ? "Dashboard refreshed! ⚡" : ""
      );

      const view = buildDashboardView(adminRow, activeGoal);
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 3. TOGGLE NOTIFICATIONS (cb:t_notif:<id>)
    // ----------------------------------------------------
    if (data.startsWith("cb:t_notif:")) {
      const channelId = data.slice("cb:t_notif:".length);

      const { data: current } = await supabase
        .from("channel_admins")
        .select(
          "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(id, title, username)"
        )
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .maybeSingle();

      if (!current) {
        return answerCallbackQuery(query.id, "Unauthorized or not found", true);
      }

      const settings = adminSettings(current);
      let nextJoins = true;
      let nextLeaves = true;
      let toast = "Alerts: All activity 🟢";

      // Cycle: All (joins=T, leaves=T) -> Joins only (T, F) -> Leaves only (F, T) -> Muted (F, F) -> All
      if (settings.notify_joins && settings.notify_leaves) {
        nextJoins = true;
        nextLeaves = false;
        toast = "Alerts: Joins only 🟡";
      } else if (settings.notify_joins && !settings.notify_leaves) {
        nextJoins = false;
        nextLeaves = true;
        toast = "Alerts: Leaves only 🟠";
      } else if (!settings.notify_joins && settings.notify_leaves) {
        nextJoins = false;
        nextLeaves = false;
        toast = "Alerts: Muted 🔴";
      } else {
        nextJoins = true;
        nextLeaves = true;
        toast = "Alerts: All activity 🟢";
      }

      await supabase
        .from("channel_admins")
        .update({
          notify_joins: nextJoins,
          notify_leaves: nextLeaves,
        })
        .eq("user_id", userId)
        .eq("channel_id", channelId);

      invalidateChannelAdminsCache(channelId);
      await answerCallbackQuery(query.id, toast);

      current.notify_joins = nextJoins;
      current.notify_leaves = nextLeaves;

      const { data: activeGoal } = await supabase
        .from("subscriber_goals")
        .select("*")
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .eq("active", true)
        .maybeSingle();

      const view = buildDashboardView(current, activeGoal);
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 4. TOGGLE USERNAME PRIVACY (cb:t_user:<id>)
    // ----------------------------------------------------
    if (data.startsWith("cb:t_user:")) {
      const channelId = data.slice("cb:t_user:".length);

      const { data: current } = await supabase
        .from("channel_admins")
        .select(
          "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(id, title, username)"
        )
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .maybeSingle();

      if (!current) {
        return answerCallbackQuery(query.id, "Unauthorized or not found", true);
      }

      const nextHide = !current.hide_usernames;

      await supabase
        .from("channel_admins")
        .update({ hide_usernames: nextHide })
        .eq("user_id", userId)
        .eq("channel_id", channelId);

      invalidateChannelAdminsCache(channelId);
      await answerCallbackQuery(
        query.id,
        nextHide ? "Usernames: Hidden 🙈" : "Usernames: Visible 👁"
      );

      current.hide_usernames = nextHide;

      const { data: activeGoal } = await supabase
        .from("subscriber_goals")
        .select("*")
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .eq("active", true)
        .maybeSingle();

      const view = buildDashboardView(current, activeGoal);
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 5. TOGGLE BATCHING WINDOW (cb:t_batch:<id>)
    // ----------------------------------------------------
    if (data.startsWith("cb:t_batch:")) {
      const channelId = data.slice("cb:t_batch:".length);

      const { data: current } = await supabase
        .from("channel_admins")
        .select(
          "channel_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds, channels(id, title, username)"
        )
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .maybeSingle();

      if (!current) {
        return answerCallbackQuery(query.id, "Unauthorized or not found", true);
      }

      const curSeconds = current.batch_window_seconds || 0;
      let nextSeconds = 0;
      let toast = "Batching: Instant ⚡";

      // Cycle: 0 -> 30 -> 60 -> 300 -> 0
      if (curSeconds === 0) {
        nextSeconds = 30;
        toast = "Batching: 30 seconds ⏳";
      } else if (curSeconds === 30) {
        nextSeconds = 60;
        toast = "Batching: 1 minute ⏳";
      } else if (curSeconds === 60) {
        nextSeconds = 300;
        toast = "Batching: 5 minutes ⏳";
      } else {
        nextSeconds = 0;
        toast = "Batching: Instant ⚡";
      }

      await supabase
        .from("channel_admins")
        .update({ batch_window_seconds: nextSeconds })
        .eq("user_id", userId)
        .eq("channel_id", channelId);

      invalidateChannelAdminsCache(channelId);
      await answerCallbackQuery(query.id, toast);

      current.batch_window_seconds = nextSeconds;

      const { data: activeGoal } = await supabase
        .from("subscriber_goals")
        .select("*")
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .eq("active", true)
        .maybeSingle();

      const view = buildDashboardView(current, activeGoal);
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 6. VIEW GOAL DETAILS (cb:goal_view:<id>)
    // ----------------------------------------------------
    if (data.startsWith("cb:goal_view:")) {
      const channelId = data.slice("cb:goal_view:".length);
      await answerCallbackQuery(query.id);

      const { data: goal } = await supabase
        .from("subscriber_goals")
        .select("*")
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .eq("active", true)
        .maybeSingle();

      const { data: ch } = await supabase
        .from("channels")
        .select("id, title, username")
        .eq("id", channelId)
        .maybeSingle();

      const view = buildGoalDetailView(goal, ch || { title: "Channel" }, channelId);
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 7. CLEAR GOAL (cb:goal_clear:<id>)
    // ----------------------------------------------------
    if (data.startsWith("cb:goal_clear:")) {
      const channelId = data.slice("cb:goal_clear:".length);

      await supabase
        .from("subscriber_goals")
        .update({
          active: false,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("channel_id", channelId)
        .eq("active", true);

      await answerCallbackQuery(query.id, "Subscriber goal cleared! ✅");

      const { data: ch } = await supabase
        .from("channels")
        .select("id, title, username")
        .eq("id", channelId)
        .maybeSingle();

      const view = buildGoalDetailView(null, ch || { title: "Channel" }, channelId);
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 8. VIEW REJOINERS (cb:rejoin_view:<id>)
    // ----------------------------------------------------
    if (data.startsWith("cb:rejoin_view:")) {
      const channelId = data.slice("cb:rejoin_view:".length);
      await answerCallbackQuery(query.id, "Loading re-joiners...");

      const { data: ch } = await supabase
        .from("channels")
        .select("id, title, username")
        .eq("id", channelId)
        .maybeSingle();

      const { data: events, error: eventsError } = await supabase
        .from("events")
        .select("user_id, username, event_type, created_at, event_time")
        .eq("channel_id", channelId)
        .order("created_at", { ascending: true });

      if (eventsError) {
        err("rejoiners callback fetch failed:", eventsError.message);
        return;
      }

      const view = buildRejoinersDetailView(
        ch || { title: "Channel" },
        events || [],
        channelId
      );
      return editMessageText(chatId, messageId, view.text, {
        reply_markup: view.reply_markup,
      });
    }

    // ----------------------------------------------------
    // 9. MEMBER DOSSIER FROM NOTIFICATION (cb:dossier:<channelId>:<userId>)
    // ----------------------------------------------------
    if (data.startsWith("cb:dossier:")) {
      const parts = data.split(":");
      const channelId = parts[2];
      const targetUserId = parts[3];

      await answerCallbackQuery(query.id, "Loading member dossier...");

      const { data: ch } = await supabase
        .from("channels")
        .select("id, title, username")
        .eq("id", channelId)
        .maybeSingle();

      const { data: events } = await supabase
        .from("events")
        .select("*")
        .eq("channel_id", channelId)
        .eq("user_id", targetUserId)
        .order("created_at", { ascending: true });

      let report;
      if (events?.length) {
        report = buildSubscriberHistoryReport(
          targetUserId,
          ch || { title: "Channel" },
          events
        );
      } else {
        const liveMember = await getChatMember(channelId, targetUserId);
        report = buildPreExistingMemberReport(
          targetUserId,
          ch || { title: "Channel" },
          liveMember,
          []
        );
      }

      return sendMessage(chatId, report, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⚙️ Channel Dashboard",
                callback_data: `cb:ch_view:${channelId}`,
              },
            ],
          ],
        },
      });
    }

    // Fallback: answer unknown query
    await answerCallbackQuery(query.id);
  } catch (e) {
    err("handleCallbackQuery error:", e.message);
    try {
      await answerCallbackQuery(query.id, "An error occurred");
    } catch (_) {}
  }
}

module.exports = {
  handleCallbackQuery,
};
