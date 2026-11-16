-- One row per Sidebots server that has registered. `sent_count` counts the
-- notifications it has sent on `sent_day`, in days since 1970.
create table if not exists machines (
  id          text primary key,
  public_key  text not null unique,
  created_at  integer not null,
  seen_at     integer not null,
  sent_day    integer not null default 0,
  sent_count  integer not null default 0
);
