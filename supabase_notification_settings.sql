alter table public.channel_admins
  add column if not exists notify_joins boolean not null default true,
  add column if not exists notify_leaves boolean not null default true,
  add column if not exists hide_usernames boolean not null default false;
