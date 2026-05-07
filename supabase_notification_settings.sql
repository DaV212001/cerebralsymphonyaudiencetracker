alter table public.channel_admins
  add column if not exists notify_joins boolean not null default true,
  add column if not exists notify_leaves boolean not null default true,
  add column if not exists hide_usernames boolean not null default false,
  add column if not exists batch_window_seconds integer not null default 0;

create table if not exists public.notification_batches (
  id bigserial primary key,
  user_id bigint not null,
  channel_id bigint not null,
  event_type text not null check (event_type in ('JOIN', 'LEAVE')),
  count integer not null default 1,
  first_event_at timestamptz not null,
  last_event_at timestamptz not null,
  flush_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done')),
  channel_title text,
  channel_username text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists notification_batches_pending_unique
  on public.notification_batches (user_id, channel_id, event_type)
  where status = 'pending';

create index if not exists notification_batches_flush_idx
  on public.notification_batches (status, flush_at);

create table if not exists public.broadcasts (
  id bigserial primary key,
  admin_user_id bigint not null,
  header text not null default 'Update from ChannelSubTracker',
  text text not null,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.broadcast_messages (
  id bigserial primary key,
  broadcast_id bigint not null references public.broadcasts(id) on delete cascade,
  user_id bigint not null,
  message_id bigint,
  status text not null default 'sent'
    check (status in ('sent', 'failed', 'edited', 'edit_failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists broadcast_messages_broadcast_idx
  on public.broadcast_messages (broadcast_id, status);

create table if not exists public.subscriber_goals (
  id bigserial primary key,
  user_id bigint not null,
  channel_id bigint not null,
  target_count integer not null check (target_count > 0),
  last_count integer not null default 0,
  active boolean not null default true,
  channel_title text,
  channel_username text,
  achieved_at timestamptz,
  celebration_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists subscriber_goals_active_unique
  on public.subscriber_goals (user_id, channel_id)
  where active = true;

create index if not exists subscriber_goals_channel_idx
  on public.subscriber_goals (channel_id, active);
