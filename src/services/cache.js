const { supabase } = require("../config");
const { err } = require("../utils/logger");

const channelAdminsCache = new Map();
const CHANNEL_ADMINS_CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL

async function getCachedChannelAdmins(channelId) {
  const key = String(channelId);
  const cached = channelAdminsCache.get(key);
  const now = Date.now();

  if (cached && now - cached.timestamp < CHANNEL_ADMINS_CACHE_TTL_MS) {
    return cached.data;
  }

  const { data: admins, error: adminLookupError } = await supabase
    .from("channel_admins")
    .select(
      "user_id, notify_joins, notify_leaves, hide_usernames, batch_window_seconds"
    )
    .eq("channel_id", channelId);

  if (adminLookupError) {
    err("cached channel admins lookup failed:", adminLookupError.message);
    return cached ? cached.data : [];
  }

  const result = admins || [];
  channelAdminsCache.set(key, { data: result, timestamp: now });
  return result;
}

function invalidateChannelAdminsCache(channelId) {
  if (!channelId) return;
  channelAdminsCache.delete(String(channelId));
}

module.exports = {
  getCachedChannelAdmins,
  invalidateChannelAdminsCache,
};
