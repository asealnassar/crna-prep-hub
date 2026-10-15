'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  GENERAL_ADMIN, STATEMENT_ADMIN, isCurrentAdminPath, type AdminDestination,
} from '@/lib/admin/nav'

/**
 * The admin header, shared.
 *
 * ---------------------------------------------------------------------------
 * WHY A COMPONENT RATHER THAN A SIXTH COPY
 * ---------------------------------------------------------------------------
 * This markup was hand-written on each admin page, which is how the Statement
 * area ended up reachable only from inside itself: adding a destination meant
 * remembering every page that lists destinations. One component means a new
 * admin surface is one line in one file.
 *
 * THE STYLING IS NOT NEW. It is the header the Statement pages already render,
 * copied rather than designed -- the slate link colour, the border-bottom, the
 * max-w-6xl row. Those two pages therefore look exactly as they did; what they
 * gain is an active state that is computed instead of hard-coded.
 *
 * THE DESTINATIONS AND THE ACTIVE-STATE RULE LIVE IN lib/admin/nav.ts, which
 * imports nothing from React or Next so that `node --test` can load it. This
 * file renders them; it does not decide them.
 *
 * NOT THE APPLICANT SIDEBAR. components/Sidebar.tsx is untouched -- it is the
 * signed-in applicant's navigation, and ClientProviders already hides it for
 * every /admin route.
 */

export default function AdminNav() {
  const pathname = usePathname() ?? ''

  const link = (destination: AdminDestination) => (
    isCurrentAdminPath(pathname, destination.href) ? (
      <span
        key={destination.href}
        aria-current="page"
        className="font-semibold text-blue-700"
      >
        {destination.label}
      </span>
    ) : (
      <Link
        key={destination.href}
        href={destination.href}
        className="text-slate-600 hover:text-blue-600"
      >
        {destination.label}
      </Link>
    )
  )

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
        <Link href="/"><span className="text-xl font-bold text-blue-600">CRNA Prep Hub</span></Link>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          {GENERAL_ADMIN.map(link)}
          {/* The group boundary, stated once rather than drawn per page. */}
          <span aria-hidden className="text-slate-300">|</span>
          {STATEMENT_ADMIN.map(link)}
        </nav>
      </div>
    </header>
  )
}
