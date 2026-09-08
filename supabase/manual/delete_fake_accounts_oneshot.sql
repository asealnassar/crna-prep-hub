-- Delete 7 confirmed-fake test accounts.
-- IRREVERSIBLE once committed. Run manually by the account owner.
--
-- This version does NOT hand-list child tables. Two earlier drafts did and both
-- were wrong (message_reads did not exist; forum_posts was missed). Instead it
-- reads pg_constraint to find EVERY table with a foreign key to auth.users and
-- clears only these 7 user ids from each.
--
-- Scope: rows owned by these 7 accounts. Nothing else is touched.
-- Safety: aborts unless exactly 7 accounts match; wrapped in a transaction you
-- must commit yourself; prints a per-table count before you decide.

begin;

do $$
declare
  ids   uuid[];
  r     record;
  n     bigint;
  pass  int;
begin
  select array_agg(id) into ids
  from auth.users
  where email in (
    'asealnassafdvr@gmail.com','12e3@gmail.com','ewfefef@gmail.com',
    'dhhdhd@gmail.com','rffr@gmail.com','rfffr@gmail.com','sthsyr@gmail.com'
  );

  if coalesce(array_length(ids, 1), 0) <> 7 then
    raise exception 'Expected 7 accounts, found %. Aborting.',
      coalesce(array_length(ids, 1), 0);
  end if;

  -- Three passes: child tables can reference each other (a forum comment on a
  -- forum post), so a delete that fails on the first pass succeeds on a later
  -- one once its own children are gone.
  for pass in 1..3 loop
    for r in
      select con.conrelid::regclass::text as tbl, att.attname as col
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum   = con.conkey[1]
      where con.contype   = 'f'
        and con.confrelid = 'auth.users'::regclass
        and con.conrelid <> 'auth.users'::regclass
      order by con.conrelid::regclass::text
    loop
      begin
        execute format('delete from %s where %I = any($1)', r.tbl, r.col) using ids;
        get diagnostics n = row_count;
        if n > 0 then
          raise notice 'pass %: deleted % row(s) from %.%', pass, n, r.tbl, r.col;
        end if;
      exception when foreign_key_violation then
        if pass = 3 then raise; end if;   -- final pass: surface the real error
      end;
    end loop;
  end loop;

  delete from auth.users where id = any(ids);
  get diagnostics n = row_count;
  raise notice 'deleted % auth user(s)', n;
end $$;

-- Read the NOTICE output above, then:
commit;   -- or: rollback;
