/**
 * The Supabase client every Statement Studio server path uses.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS THE PROOF THAT LOCAL REVIEW CANNOT WRITE TO PRODUCTION
 * ---------------------------------------------------------------------------
 * Outside simulated-live mode it returns exactly the client those paths built
 * for themselves before it existed: the anon key plus the caller's bearer
 * token, a caller-scoped client subject to the same RLS the API is. Production
 * behaviour is unchanged, byte for byte.
 *
 * INSIDE simulated-live mode it returns the same client wrapped in a proxy that
 * REFUSES EVERY MUTATION. `.insert()`, `.update()`, `.upsert()`, `.delete()` and
 * `.rpc()` throw before a request is made. Reads pass through untouched.
 *
 * WHY A REFUSAL RATHER THAN A REDIRECT. The local review reimplements the flows
 * it supports -- drafts, the catalog, analysis -- against local storage, and
 * those never reach this client at all. This guard is for everything else: the
 * path somebody adds next month, the one this audit missed, the one that only
 * runs when a particular button is pressed. A redirect would make such a path
 * appear to work; a throw makes it stop, loudly, in development, where it is
 * cheap to find. The failure mode is a broken local screen, never a production
 * row.
 *
 * AND IT CANNOT BE SWITCHED OFF FROM OUTSIDE. simulatedLiveEnabled() reads
 * NODE_ENV, which is fixed at build time. There is no request, header, cookie
 * or query parameter that reaches this decision.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SimulatedLiveWriteBlocked, simulatedLiveEnabled } from './gate.ts'

export { SimulatedLiveWriteBlocked } from './gate.ts'
import { localDraftsBuilder } from './localDrafts.ts'
import { localCatalogBuilder } from './localCatalog.ts'
import {
  SUBMISSIONS_TABLE, SUBMISSION_FUNCTIONS, localSubmissionRpc, localSubmissionsBuilder,
} from './localSubmissions.ts'

const MUTATIONS = ['insert', 'update', 'upsert', 'delete'] as const

/** Every method on a query builder that sends a write. */
function guardBuilder(builder: unknown, table: string): unknown {
  return new Proxy(builder as object, {
    get(target, property, receiver) {
      if (typeof property === 'string'
        && (MUTATIONS as readonly string[]).includes(property)) {
        return () => { throw new SimulatedLiveWriteBlocked(property, table) }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * A caller-scoped client. In simulated-live mode, one that cannot mutate.
 *
 * The signature is the one the call sites already had, so adopting it is a
 * one-line change at each and no route's logic moves.
 */
/**
 * Who is asking, as the SERVER established it.
 *
 * ONLY SIMULATED LIVE READS THIS, and only to stand in for auth.uid() and for
 * an EXECUTE privilege. The three submission functions are SECURITY DEFINER in
 * production: they take the submitter from auth.uid() and the right to decide
 * from a service_role-only grant, so neither is ever a parameter. A local file
 * has no auth.uid() and no privileges, so the route's own verified answer is
 * passed in -- never anything from the request body.
 *
 * IT IS IGNORED OUTSIDE DEVELOPMENT. Production builds the same client it
 * always did and the parameter is unused, so no call site has to change.
 */
export interface LocalCaller {
  readonly userId: string | null
  readonly isAdmin: boolean
}

const ANONYMOUS: LocalCaller = { userId: null, isAdmin: false }

/**
 * The client the ADMIN review queue uses.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ADMIN PATH NEEDED ITS OWN HELPER
 * ---------------------------------------------------------------------------
 * The review queue is the one Statement Studio path that legitimately holds a
 * service-role key: approving a submission has to write a catalog no browser
 * role may write, and in production that is exactly right. But a service-role
 * client is not subject to RLS and was being built inline, which means it never
 * passed through this module at all -- so in simulated-live an administrator
 * reviewing LOCAL submissions would have been reading production, and pressing
 * Approve would have written it.
 *
 * SO IN DEVELOPMENT IT NEVER GETS THE KEY. The local store answers the reads
 * and stands in for the decide function; every other table refuses every write,
 * as it does for an applicant. Outside development this returns precisely the
 * client the route built for itself, with the same key and the same options --
 * production behaviour is unchanged.
 *
 * THE CALLER IS STILL CHECKED BY THE ROUTE. This helper does not authorise
 * anybody; it is handed the answer the route already established, and passes it
 * to the local stand-in because a JSON file has no EXECUTE privileges to lean
 * on.
 */
export function statementAdminClient(
  serviceKey: string,
  caller: LocalCaller,
): SupabaseClient {
  if (simulatedLiveEnabled()) {
    // NO SERVICE KEY IS EVER READ ON THIS BRANCH. The parameter is accepted so
    // the route's shape is unchanged, and deliberately unused here.
    //
    // READS OF TABLES THE LOCAL REVIEW DOES NOT OWN GO TO A READ-ONLY ANON
    // CLIENT, and that is a correction. This branch used to throw on them,
    // which was wrong in both directions: public.schools is the school
    // DIRECTORY -- ordinary reference data, readable by anon, and the only
    // thing that turns a submission's school_id into a name a reviewer can
    // recognise. Refusing it did not protect anything; it took the review
    // queue down with a SimulatedLiveWriteBlocked that nothing caught.
    //
    // THE ANON KEY, NOT THE SERVICE KEY, so RLS still applies: a table the
    // browser role cannot read is not readable here either, and the answer is
    // an ordinary PostgREST error the caller already handles rather than a
    // throw. And it is wrapped in guardBuilder, so every write still stops
    // before it leaves the machine.
    const readOnly = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )
    return new Proxy({} as SupabaseClient, {
      get(_target, property) {
        if (property === 'from') {
          return (table: string) => {
            if (table === SUBMISSIONS_TABLE) return localSubmissionsBuilder(caller)
            const catalog = localCatalogBuilder(table)
            if (catalog !== null) return catalog
            if (table === 'statement_drafts') return localDraftsBuilder()
            return guardBuilder(readOnly.from(table), table)
          }
        }
        if (property === 'rpc') {
          return (name: string, params?: Record<string, unknown>) => {
            if ((SUBMISSION_FUNCTIONS as readonly string[]).includes(name)) {
              return Promise.resolve(localSubmissionRpc(name, params ?? {}, caller))
            }
            throw new SimulatedLiveWriteBlocked('rpc', name)
          }
        }
        /*
         * A PROMISE PROBE IS NOT AN ACCESS. `await someClient` makes the
         * runtime read `.then` to decide whether the value is thenable, and
         * `console.log` reads Symbol.toStringTag -- so throwing on every
         * unknown property made the proxy impossible to await or inspect. Both
         * answer undefined, which is what a plain object would answer.
         */
        if (property === 'then' || typeof property === 'symbol') return undefined
        throw new SimulatedLiveWriteBlocked('admin client', String(property))
      },
    })
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export function statementDbClient(
  token: string,
  caller: LocalCaller = ANONYMOUS,
): SupabaseClient {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  )
  if (!simulatedLiveEnabled()) return client

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'rpc') {
        return (name: string, params?: Record<string, unknown>) => {
          // THE THREE SUBMISSION FUNCTIONS ARE SERVED LOCALLY. They are the
          // only writes an applicant has, they exist as functions precisely
          // because no role may write the tables behind them, and a throw here
          // made the whole "we do not have your school's prompt yet" path
          // unreachable on localhost. The local stand-in reproduces their
          // refusals, their rate limits and their stamped columns.
          if ((SUBMISSION_FUNCTIONS as readonly string[]).includes(name)) {
            return Promise.resolve(localSubmissionRpc(name, params ?? {}, caller))
          }
          // EVERYTHING ELSE STILL STOPS HERE. Usage accounting, the analysis
          // cache, and whatever is added next month.
          throw new SimulatedLiveWriteBlocked('rpc', name)
        }
      }
      if (property === 'from') {
        return (table: string) => {
          // THE ONE TABLE THAT IS SERVED LOCALLY. draftRepo issues its real
          // chains against this builder and gets rows from a JSON file, so the
          // repository, its optimistic concurrency and its row parsing are all
          // exercised for real while nothing leaves the machine.
          if (table === 'statement_drafts') return localDraftsBuilder()
          // THE SUBMISSIONS TABLE, served from its own local file so the
          // repository's real chains run and the editor can say a pasted
          // prompt is awaiting review. Direct writes to it throw there too.
          if (table === SUBMISSIONS_TABLE) return localSubmissionsBuilder(caller)
          // THE CATALOG, SERVED FROM THE LOCAL PAYLOAD. Production's 63 sets are
          // all is_active = false, so the real read correctly returns nothing;
          // this returns the 62 that 005 would let you activate. repo.ts issues
          // its real queries and parses real rows -- only the source moved.
          const catalog = localCatalogBuilder(table)
          if (catalog !== null) return catalog
          // Everything else may still be READ from production -- the catalog,
          // the school list -- and may never be written.
          return guardBuilder(target.from(table), table)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as SupabaseClient
}
