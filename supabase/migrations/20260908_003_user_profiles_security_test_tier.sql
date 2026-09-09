-- ============================================================================
-- Hidden test tier for broadcast-boundary regression coverage
-- ============================================================================
--
-- Widens ONE existing CHECK constraint by ONE value. Nothing else on
-- user_profiles is touched: no column, no default, no index, no other
-- constraint, no policy, no grant, and no existing member's tier.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Durable-email Phase 2 adds an AFTER INSERT trigger on thread_messages plus a
-- transaction-local GUC that send_tier_broadcast sets to suppress it. Get that
-- wrong and every broadcast recipient is emailed twice -- once by the batch
-- system, once by the new worker. It is the highest-risk boundary in the
-- project and it currently has no automated coverage at all.
--
-- Proving it needs a REAL send_tier_broadcast call, and that RPC selects its
-- recipients by tier. Every existing tier is populated with real members --
-- free 424, ultimate 126, premium 16 -- so there is no tier that can be
-- broadcast to safely. This creates one that holds throwaway accounts only.
--
-- WHY IT IS INVISIBLE TO THE PRODUCT
-- ---------------------------------------------------------------------------
-- Checked at every surface rather than assumed:
--
--   * the admin broadcast selector offers three hardcoded <option> values, so
--     'security-test' cannot be chosen in the UI;
--   * app/api/messages/broadcast/route.ts pins
--     ALLOWED_TIERS = ['free','premium','ultimate'] and returns 400 for
--     anything else -- deliberately NOT widened here, so the test cohort is
--     structurally unable to reach Resend through the email route;
--   * transcriptAllowanceFor() is `=== 'ultimate' ? null : 1`, so an
--     unrecognised tier gets the free allowance rather than throwing;
--   * apiAuth's isUltimate is `tier === 'ultimate'`, so it is false;
--   * admin analytics filters `=== 'premium'` for its count and falls through
--     to a default badge style.
--
-- Every gate treats an unknown tier as the least privileged case. Nothing
-- enumerates the set exhaustively and nothing crashes on a new value.
--
-- SAFETY OF THE CHANGE ITSELF
-- ---------------------------------------------------------------------------
-- Drop-and-recreate inside one transaction, because Postgres offers no
-- in-place way to widen a CHECK. DDL is transactional here, so a failure at
-- any point leaves the original constraint intact -- the table is never left
-- unconstrained.
--
-- The new constraint is validated against all 566 existing rows on creation.
-- That is intended: every current value (free, premium, ultimate) remains
-- permitted, so validation confirms the widening is purely additive. NOT VALID
-- is deliberately NOT used -- skipping validation here would hide exactly the
-- mistake this statement could make.
-- ============================================================================

begin;

-- The constraint as it exists today, recorded so the change is reviewable:
--
--   CHECK (subscription_tier = ANY (ARRAY['free'::text,
--                                         'premium'::text,
--                                         'ultimate'::text]))
alter table public.user_profiles
  drop constraint user_profiles_subscription_tier_check;

alter table public.user_profiles
  add constraint user_profiles_subscription_tier_check
  check (
    subscription_tier = any (
      array[
        'free'::text,
        'premium'::text,
        'ultimate'::text,
        'security-test'::text
      ]
    )
  );

commit;

-- ---------------------------------------------------------------------------
-- NO DATA CHANGE HERE, DELIBERATELY
-- ---------------------------------------------------------------------------
-- This migration moves nobody into the new tier. The two throwaway accounts
-- are assigned separately and verified by exact identity, so a migration
-- replayed against another environment can never reassign an account that
-- happens to share an address.

-- ---------------------------------------------------------------------------
-- READ-ONLY VERIFICATION (run after applying; returns rows, changes nothing)
-- ---------------------------------------------------------------------------
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.user_profiles'::regclass and contype = 'c';
--
-- select subscription_tier, count(*)
--   from public.user_profiles group by 1 order by 2 desc;
--   -- expect free 424, ultimate 126, premium 16, security-test 0
