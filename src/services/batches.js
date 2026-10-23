const { supabase } = require("../config");
const { channelDisplay } = require("../utils/helpers");
const { sendMessage } = require("./telegram");
const { err } = require("../utils/logger");

function eventWord(eventType, count) {
  const word = eventType === "JOIN" ? "join" : "leave";
  return count === 1 ? word : `${word}s`;
}

function batchMessage(row) {
  const channel = {
    title: row.channel_title,
    username: row.channel_username,
  };

  return `
<b>${row.event_type === "JOIN" ? "JOIN" : "LEAVE"} SUMMARY</b>

${row.count} ${eventWord(row.event_type, row.count)} during recent activity
━━━━━━━━━━━━━━
📢 ${channelDisplay(channel)}

🆔 Channel ID: <code>${row.channel_id}</code>
━━━━━━━━━━━━━━
First: ${new Date(row.first_event_at).toLocaleString()}
Latest: ${new Date(row.last_event_at).toLocaleString()}
`;
}

async function queueBatchNotification({
  admin,
  settings,
  channel,
  eventType,
  time,
}) {
  const now = new Date();
  const flushAt = new Date(
    now.getTime() + settings.batch_window_seconds * 1000
  ).toISOString();

  const { data: existing, error: selectError } = await supabase
    .from("notification_batches")
    .select("id, count, first_event_at")
    .eq("status", "pending")
    .eq("user_id", admin.user_id)
    .eq("channel_id", channel.id)
    .eq("event_type", eventType)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("notification_batches")
      .update({
        count: (existing.count || 0) + 1,
        last_event_at: time.toISOString(),
        flush_at: flushAt,
        channel_title: channel.title,
        channel_username: channel.username || null,
      })
      .eq("id", existing.id);

    if (updateError) throw updateError;
    return;
  }

  const { error: insertError } = await supabase
    .from("notification_batches")
    .insert({
      user_id: admin.user_id,
      channel_id: channel.id,
      event_type: eventType,
      count: 1,
      first_event_at: time.toISOString(),
      last_event_at: time.toISOString(),
      flush_at: flushAt,
      status: "pending",
      channel_title: channel.title,
      channel_username: channel.username || null,
    });

  if (insertError) throw insertError;
}

async function flushDueBatches() {
  const { data: batches, error: selectError } = await supabase
    .from("notification_batches")
    .select("*")
    .eq("status", "pending")
    .lte("flush_at", new Date().toISOString())
    .limit(20);

  if (selectError) {
    err("batch select failed:", selectError.message);
    return;
  }

  if (!batches?.length) return;

  await supabase
    .from("notification_batches")
    .update({ status: "processing" })
    .in("id", batches.map((b) => b.id));

  for (const batch of batches) {
    try {
      await sendMessage(batch.user_id, batchMessage(batch));

      await supabase
        .from("notification_batches")
        .update({ status: "done", sent_at: new Date().toISOString() })
        .eq("id", batch.id);
    } catch (e) {
      err("batch send failed:", e.message);

      await supabase
        .from("notification_batches")
        .update({
          status: "pending",
          flush_at: new Date(Date.now() + 60000).toISOString(),
        })
        .eq("id", batch.id);
    }
  }
}

module.exports = {
  eventWord,
  batchMessage,
  queueBatchNotification,
  flushDueBatches,
};
