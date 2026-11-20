-- One row per Sidebots server that has registered. `tunnel_id` is the
-- Cloudflare Tunnel that gives it its address, once the relay has made it.
-- `sent_count` counts the notifications it has sent on `sent_day`, in days
-- since 1970. `version`, `agents` and `phones` are what it last said of
-- itself: the version of the Mac app it runs in, and how many agents and
-- paired phones it has. They are null for a machine that says nothing.
create table if not exists machines (
  id          text primary key,
  public_key  text not null unique,
  tunnel_id   text,
  created_at  integer not null,
  seen_at     integer not null,
  sent_day    integer not null default 0,
  sent_count  integer not null default 0,
  version     text,
  agents      integer,
  phones      integer
);

-- The turns a machine said its agents ran on one day, by provider and kind of
-- turn. `day` is the date on the machine, as `2026-11-19`. The rows stay when
-- the machine is removed.
create table if not exists turns (
  machine_id  text not null,
  day         text not null,
  provider    text not null,
  kind        text not null,
  turns       integer not null,
  primary key (machine_id, day, provider, kind)
);
