import { ChevronDown } from 'lucide-react'

interface FaqItem {
  question: string
  answer: string
}

/**
 * "Is this one-time / lifetime access" restates the claim already published on
 * this page ("One-time payment. Lifetime access. No subscriptions.") and in
 * app/pricing/layout.tsx's metadata -- not a new claim. "Can I upgrade later"
 * reflects verified checkout behavior: buying a higher plan works regardless
 * of the plan you're currently on (app/pricing/page.tsx's handleCheckout).
 * No refund policy exists anywhere in this codebase, so that answer routes to
 * support rather than stating a policy -- flagged for owner review.
 */
const FAQS: FaqItem[] = [
  {
    question: 'Is this really a one-time payment?',
    answer:
      'Yes. Premium and Ultimate are both one-time purchases, not subscriptions — there’s nothing recurring and nothing to cancel.',
  },
  {
    question: 'Will I have lifetime access?',
    answer:
      'Yes. Once you upgrade, your access to that plan’s features doesn’t expire.',
  },
  {
    question: 'Can I upgrade later?',
    answer:
      'Yes. You can move up to a higher plan at any time from this page — you’ll get full access to the new plan right away.',
  },
  {
    question: 'Do you offer a refund?',
    answer:
      'For refund questions, reach out to support@crnaprephub.com and our team will help.',
  },
]

export default function FaqAccordion() {
  return (
    <div className="divide-y divide-gray-200 rounded-2xl border border-gray-200 bg-white">
      {FAQS.map((faq) => (
        <details key={faq.question} className="group px-5 sm:px-6 py-1">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-semibold text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 rounded-lg">
            {faq.question}
            <ChevronDown
              className="h-5 w-5 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <p className="pb-4 text-sm leading-relaxed text-gray-600">{faq.answer}</p>
        </details>
      ))}
    </div>
  )
}
