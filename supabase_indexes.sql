-- Performance indexes for ChannelSubTracker
-- Run this once in the Supabase SQL Editor.

-- Worker hot poll: SELECT ... WHERE status='pending' AND next_retry_at <= now()
-- Without this, the worker does a full table scan every ~1 second.
CREATE INDEX IF NOT EXISTS event_queue_pending_idx
  ON public.event_queue (status, next_retry_at);

-- Join/leave handler hot lookup: SELECT ... WHERE channel_id = ?
-- Without this, every join/leave event scans the full channel_admins table.
CREATE INDEX IF NOT EXISTS channel_admins_channel_idx
  ON public.channel_admins (channel_id);
