-- ============================================================================
-- ANALYTICS PHASE 3: FIRST-PARTY TRAFFIC TRACKING
--
-- WHAT THIS ADDS. Four new tables in `public`, nothing else. No existing table,
-- column, constraint, index, policy, trigger, function or row is touched. It is
-- additive in the strict sense: applying it changes no behaviour anywhere in
-- the product, and the dashboard reads these tables as "nothing recorded yet"
-- until the tracker is switched on.
--
--   analytics_visitors   one row per browser that has ever loaded a page, with
--                        its FIRST-TOUCH source frozen at creation.
--   analytics_sessions   one row per visit, with that visit's LAST-TOUCH source
--                        and a running page-view count.
--   analytics_events     one row per tracked event, deduplicated on a client
--                        generated event_id.
--   analytics_ad_spend   manually imported ad spend. Empty until someone
--                        imports a CSV; never inferred, never invented.
--
-- WHAT IS DELIBERATELY NOT STORED. No IP address, no raw User-Agent, no email,
-- no name, no screen fingerprint, no page title, no query string, no form
-- content, and nothing from an interview, resume, personal statement or
-- message. A visitor is a random UUID in a first-party cookie and nothing else.
-- The only join to a real person is analytics_visitors.user_id, written once at
-- signup so the funnel can end somewhere, and it is ON DELETE SET NULL so
-- deleting an account detaches the trail.
--
-- WHO CAN READ IT. Nobody but the server. RLS is enabled on all four tables and
-- NO POLICY IS CREATED, so anon and authenticated can read and write nothing
-- even if a key leaks into the browser. service_role bypasses RLS and is the
-- only path in, which is why the ingest endpoint writes server-side.
--
-- THE DEFAULT-PRIVILEGES TRAP, CLOSED HERE RATHER THAN IN A LATER FILE. A
-- Supabase project ships ALTER DEFAULT PRIVILEGES granting anon, authenticated
-- and service_role privileges on every new table in `public`. Those are
-- EXPLICIT grants to named roles: `revoke ... from public` does NOT remove
-- them, which is exactly what migration 010 had to come back and fix for a
-- function. Every revoke below therefore names each role. RLS would already
-- stop a select, but a table whose grants say `authenticated` may read it is a
-- table the next reader believes is readable.
--
-- RETENTION. analytics_prune(days) deletes events past their retention window
-- and then the sessions and visitors nothing references. It is a plain function
-- owned by the migration runner and callable only by service_role. Nothing
-- schedules it; see the note above the function for how to run it.
--
-- PRE-FLIGHT (read-only). Expect four rows of `false` -- none of these tables
-- exists yet. If any returns true, STOP: this file has already been applied.
--   select t.name, to_regclass('public.' || t.name) is not null as exists_already
--   from   (values ('analytics_visitors'), ('analytics_sessions'),
--                  ('analytics_events'),   ('analytics_ad_spend')) as t(name);
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. VISITORS. One per browser. First touch is written once and never updated.
-- ---------------------------------------------------------------------------
create table public.analytics_visitors (
  visitor_id          uuid        primary key,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),

  -- FIRST TOUCH: how this visitor found the site the very first time. The
  -- ingest endpoint writes these only on INSERT, so a later visit from another
  -- source cannot rewrite history.
  --
  -- first_channel is the grouped answer ('tiktok', 'google_ads', 'direct'...)
  -- and is decided once, at the moment of the visit, when the referrer and the
  -- query string are both still in hand. Re-deriving it later from the columns
  -- below would be a guess made with less information than the writer had.
  first_channel       text,
  first_source        text,
  first_medium        text,
  first_campaign      text,
  first_referrer_host text,
  first_landing_path  text,

  -- Set once, at signup, by the ingest endpoint. Null for everyone who never
  -- registered, which is most visitors.
  user_id             uuid references auth.users (id) on delete set null,
  linked_at           timestamptz,

  -- IF THERE IS AN ACCOUNT, WE KNOW WHEN IT WAS LINKED. Deliberately NOT the
  -- biconditional `(user_id is null) = (linked_at is null)`, which was the
  -- first version of this line and was wrong in a way that only shows up on
  -- the day it matters most: the foreign key above is ON DELETE SET NULL, so
  -- deleting an account nulls user_id and leaves linked_at set -- which that
  -- constraint rejected, making the DELETE fail. A visitor row would then
  -- block erasure of the account it points at. A detached row keeps its
  -- timestamp, counts as anonymous, and is pruned on the normal schedule.
  constraint analytics_visitors_linked_together
    check (user_id is null or linked_at is not null)
);

comment on table public.analytics_visitors is
  'One row per browser. Holds first-touch attribution and, after signup, the account it became. No IP, no user agent, no personal data.';

-- ---------------------------------------------------------------------------
-- 2. SESSIONS. One per visit. Carries that visit''s source -- the last touch.
--
-- page_view_count lives here on purpose: every traffic total the dashboard
-- shows except "most visited pages" can then be answered from this table alone,
-- which is two orders of magnitude smaller than the event log.
-- ---------------------------------------------------------------------------
create table public.analytics_sessions (
  session_id      uuid        primary key,
  visitor_id      uuid        not null references public.analytics_visitors (visitor_id) on delete cascade,
  started_at      timestamptz not null default now(),
  last_event_at   timestamptz not null default now(),

  -- LAST TOUCH for anything that happens in this visit.
  channel         text,
  source          text,
  medium          text,
  campaign        text,
  content         text,
  term            text,
  referrer_host   text,
  landing_path    text,

  -- Derived server-side from the User-Agent, which is then discarded. Coarse
  -- on purpose: 'mobile' and 'Safari', never a version or a fingerprint.
  device          text,
  browser         text,

  -- True when this visit created the visitor. New vs returning is read from
  -- here rather than recomputed, so the number cannot drift.
  is_first_visit  boolean     not null default false,
  page_view_count integer     not null default 0,

  constraint analytics_sessions_page_views_sane check (page_view_count >= 0)
);

comment on table public.analytics_sessions is
  'One row per visit (30 minutes of inactivity ends it). Holds last-touch attribution and this visit''s page-view count.';

-- ---------------------------------------------------------------------------
-- 3. EVENTS. The detail behind the counts.
--
-- event_id is generated by the browser and UNIQUE. The ingest endpoint inserts
-- with ON CONFLICT DO NOTHING, so a retried request, a double-fired navigation
-- or a user mashing refresh cannot inflate a number.
-- ---------------------------------------------------------------------------
create table public.analytics_events (
  id            bigint      generated always as identity primary key,
  event_id      uuid        not null unique,
  session_id    uuid        not null references public.analytics_sessions (session_id) on delete cascade,
  visitor_id    uuid        not null references public.analytics_visitors (visitor_id) on delete cascade,
  occurred_at   timestamptz not null default now(),
  kind          text        not null,
  -- Path only. Never the query string: that is where a UTM, an email in a
  -- reset link, or anything else a marketer appends would end up.
  path          text,
  referrer_host text,

  constraint analytics_events_kind_known
    check (kind in ('page_view', 'signup'))
);

comment on table public.analytics_events is
  'One row per tracked event, deduplicated on event_id. Paths only -- never query strings, never page content.';

-- ---------------------------------------------------------------------------
-- 4. AD SPEND. Imported by hand. Empty is empty, and the dashboard says so
--    rather than drawing a zero.
-- ---------------------------------------------------------------------------
create table public.analytics_ad_spend (
  id           bigint      generated always as identity primary key,
  platform     text        not null,
  spend_date   date        not null,
  campaign     text        not null default '(all campaigns)',
  spend_cents  bigint      not null,
  impressions  bigint,
  clicks       bigint,
  currency     text        not null default 'usd',
  imported_at  timestamptz not null default now(),
  imported_by  text,

  constraint analytics_ad_spend_platform_known check (platform in ('tiktok', 'google_ads')),
  constraint analytics_ad_spend_not_negative   check (spend_cents >= 0),
  constraint analytics_ad_spend_one_per_day    unique (platform, spend_date, campaign)
);

comment on table public.analytics_ad_spend is
  'Ad spend imported manually from TikTok Ads Manager and Google Ads. Never inferred. A missing day is missing, not zero.';

-- ---------------------------------------------------------------------------
-- 5. INDEXES. One per question the dashboard actually asks.
-- ---------------------------------------------------------------------------
create index analytics_visitors_first_seen_idx on public.analytics_visitors (first_seen_at);
create index analytics_visitors_user_idx       on public.analytics_visitors (user_id) where user_id is not null;

create index analytics_sessions_started_idx    on public.analytics_sessions (started_at);
create index analytics_sessions_channel_idx    on public.analytics_sessions (channel, started_at);
create index analytics_sessions_visitor_idx    on public.analytics_sessions (visitor_id, started_at);

create index analytics_events_occurred_idx     on public.analytics_events (occurred_at);
create index analytics_events_session_idx      on public.analytics_events (session_id);
create index analytics_events_kind_idx         on public.analytics_events (kind, occurred_at);

create index analytics_ad_spend_date_idx       on public.analytics_ad_spend (spend_date);

-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY. Enabled with no policies: that denies anon and
--    authenticated everything. service_role bypasses RLS and is the only way
--    in, which is why the browser posts to an endpoint instead of the database.
-- ---------------------------------------------------------------------------
alter table public.analytics_visitors enable row level security;
alter table public.analytics_sessions enable row level security;
alter table public.analytics_events   enable row level security;
alter table public.analytics_ad_spend enable row level security;

-- Forced, so that even the table owner cannot read around RLS by accident.
alter table public.analytics_visitors force row level security;
alter table public.analytics_sessions force row level security;
alter table public.analytics_events   force row level security;
alter table public.analytics_ad_spend force row level security;

-- ---------------------------------------------------------------------------
-- 7. GRANTS. Each role named explicitly -- see the header on why `from public`
--    alone is not enough.
-- ---------------------------------------------------------------------------
revoke all on public.analytics_visitors from public, anon, authenticated;
revoke all on public.analytics_sessions from public, anon, authenticated;
revoke all on public.analytics_events   from public, anon, authenticated;
revoke all on public.analytics_ad_spend from public, anon, authenticated;

grant select, insert, update, delete on public.analytics_visitors to service_role;
grant select, insert, update, delete on public.analytics_sessions to service_role;
grant select, insert, update, delete on public.analytics_events   to service_role;
grant select, insert, update, delete on public.analytics_ad_spend to service_role;

-- ---------------------------------------------------------------------------
-- 8. THE WRITE PATH: one function, one round trip, atomic.
--
-- WHY A FUNCTION RATHER THAN THREE REST CALLS. Recording a page view touches
-- three tables and has to increment a counter. Done over PostgREST that is a
-- read, a write and a race: two page views arriving together would both read
-- page_view_count = 4 and both write 5. Here it is `count + 1` inside one
-- statement in one transaction.
--
-- DEDUPLICATION LIVES HERE TOO. The event insert is ON CONFLICT DO NOTHING on
-- the unique event_id, and the page-view counter is incremented ONLY when that
-- insert actually wrote a row. A retried request, a double-fired navigation or
-- a refresh loop therefore changes nothing at all, rather than inflating the
-- count while the event is correctly ignored.
--
-- THE CLOCK IS OURS. occurred_at is now(), never a value from the browser: a
-- device with a wrong clock would otherwise land events in the wrong day, or
-- in a day that has not happened yet.
--
-- FIRST TOUCH IS WRITTEN ONCE. The visitor insert is ON CONFLICT DO NOTHING,
-- so a returning visitor arriving from a new campaign cannot rewrite how they
-- originally found the site. The account link is likewise only ever set when
-- it is still null.
-- ---------------------------------------------------------------------------
create function public.analytics_record_event(
  p_event_id       uuid,
  p_visitor_id     uuid,
  p_session_id     uuid,
  p_kind           text,
  p_channel        text    default null,
  p_source         text    default null,
  p_medium         text    default null,
  p_campaign       text    default null,
  p_content        text    default null,
  p_term           text    default null,
  p_referrer_host  text    default null,
  p_landing_path   text    default null,
  p_device         text    default null,
  p_browser        text    default null,
  p_is_first_visit boolean default false,
  p_user_id        uuid    default null
)
returns boolean
language plpgsql
as $$
declare
  -- An INTEGER, not a boolean. `get diagnostics <boolean> = row_count` happens
  -- to work today because PL/pgSQL falls back to an I/O conversion and
  -- boolean's input function accepts '1' and '0' -- but it would raise
  -- "invalid input syntax for type boolean" the moment a statement affected
  -- two rows. Counting rows in a row counter removes the trap.
  inserted integer := 0;
begin
  -- 1. The visitor, with first touch frozen at creation.
  insert into public.analytics_visitors (
    visitor_id, first_seen_at, last_seen_at,
    first_channel, first_source, first_medium, first_campaign,
    first_referrer_host, first_landing_path
  )
  values (
    p_visitor_id, now(), now(),
    p_channel, p_source, p_medium, p_campaign,
    p_referrer_host, p_landing_path
  )
  on conflict (visitor_id) do nothing;

  update public.analytics_visitors
  set    last_seen_at = now()
  where  visitor_id = p_visitor_id;

  -- 2. The account link, set once and never overwritten.
  if p_user_id is not null then
    update public.analytics_visitors
    set    user_id = p_user_id, linked_at = now()
    where  visitor_id = p_visitor_id
      and  user_id is null;
  end if;

  -- 3. The session, with this visit's last touch.
  insert into public.analytics_sessions (
    session_id, visitor_id, started_at, last_event_at,
    channel, source, medium, campaign, content, term,
    referrer_host, landing_path, device, browser, is_first_visit
  )
  values (
    p_session_id, p_visitor_id, now(), now(),
    p_channel, p_source, p_medium, p_campaign, p_content, p_term,
    p_referrer_host, p_landing_path, p_device, p_browser, coalesce(p_is_first_visit, false)
  )
  on conflict (session_id) do nothing;

  -- 4. The event. The unique event_id is what makes this idempotent.
  insert into public.analytics_events (
    event_id, session_id, visitor_id, occurred_at, kind, path, referrer_host
  )
  values (
    p_event_id, p_session_id, p_visitor_id, now(), p_kind, p_landing_path, p_referrer_host
  )
  on conflict (event_id) do nothing;

  get diagnostics inserted = row_count;

  -- 5. Only a genuinely new page view moves the counter.
  if inserted > 0 then
    update public.analytics_sessions
    set    last_event_at   = now(),
           page_view_count = page_view_count + (case when p_kind = 'page_view' then 1 else 0 end)
    where  session_id = p_session_id;
  end if;

  return inserted > 0;
end;
$$;

comment on function public.analytics_record_event is
  'Records one tracked event atomically: visitor, session, event and page-view counter. Idempotent on event_id.';

revoke all on function public.analytics_record_event(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, uuid) from public;
revoke all on function public.analytics_record_event(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, uuid) from anon;
revoke all on function public.analytics_record_event(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, uuid) from authenticated;
grant  execute on function public.analytics_record_event(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. RETENTION.
--
-- Nothing schedules this. Run it from the Supabase SQL editor, or from a cron
-- job using the service key:  select public.analytics_prune(400);
--
-- 400 days is the default because it lets the dashboard compare a full year
-- against the one before it and then lets the older half go. Events are the
-- bulk and go first; a session with no events left and a visitor with no
-- sessions left are deleted after, unless the visitor has become an account,
-- in which case the visitor row is kept so the funnel still joins.
-- ---------------------------------------------------------------------------
create function public.analytics_prune(retention_days integer default 400)
returns table (events_deleted bigint, sessions_deleted bigint, visitors_deleted bigint)
language plpgsql
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 30));
  e bigint; s bigint; v bigint;
begin
  delete from public.analytics_events where occurred_at < cutoff;
  get diagnostics e = row_count;

  delete from public.analytics_sessions ses
  where  ses.last_event_at < cutoff
    and  not exists (select 1 from public.analytics_events ev where ev.session_id = ses.session_id);
  get diagnostics s = row_count;

  delete from public.analytics_visitors vis
  where  vis.last_seen_at < cutoff
    and  vis.user_id is null
    and  not exists (select 1 from public.analytics_sessions ses where ses.visitor_id = vis.visitor_id);
  get diagnostics v = row_count;

  return query select e, s, v;
end;
$$;

comment on function public.analytics_prune(integer) is
  'Deletes analytics rows older than the retention window. Keeps visitors that became accounts so the conversion funnel still joins.';

-- Callable by the server key only. Named roles, for the reason in the header.
revoke all on function public.analytics_prune(integer) from public;
revoke all on function public.analytics_prune(integer) from anon;
revoke all on function public.analytics_prune(integer) from authenticated;
grant  execute on function public.analytics_prune(integer) to service_role;

commit;
