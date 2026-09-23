# Phase 3 privacy review — for your approval before tracking is switched on

I am not a lawyer and this is not legal advice. It is a factual description of
what the new tracking collects, what I found already running on the site, and
the decisions that are yours to make. Where I recommend something, I say so.

---

## 1. The finding that matters most, and it is not about Phase 3

**The site has no privacy policy.** I searched the whole application: there is
no `/privacy` route, no `/terms`, no cookie notice and no consent banner
anywhere. The footer and the sidebar link to neither.

Meanwhile `app/layout.tsx` already loads two third-party advertising trackers
on every page, for every visitor, with no notice and no consent:

| What | Where | What it does |
|---|---|---|
| Google Ads tag `AW-17939352347` | `app/layout.tsx` | Sets Google advertising cookies, reports to Google |
| TikTok Pixel `D6KMK3BC77U3SAC89I80` | `app/layout.tsx` | Sets TikTok cookies, reports page views to TikTok |
| TikTok server event | `/api/tiktok-event` | Sends the **email address** of every new registration to TikTok |

That last row is the one I would look at first. A registrant's email address is
sent to TikTok at signup, and nothing on the site tells them so.

**This pre-dates Phase 3 and Phase 3 does not make it worse** — but switching on
a new tracker is the natural moment to fix it, and I would not switch anything
on until the policy exists.

## 2. What the new first-party tracking collects

Everything, exhaustively:

| Stored | Not stored |
|---|---|
| A random UUID in a first-party cookie (`cph_vid`, 180 days) | IP address |
| A random UUID per visit (`cph_sid`, 30 minutes) | User-Agent string |
| Page **path** (`/pricing`) | Query strings, ever |
| Referring **host** (`tiktok.com`) | Referring URL or its path |
| UTM source / medium / campaign | Name, email, or any contact detail |
| Coarse device (`mobile`) and browser (`Safari`) | Screen size, fonts, canvas, any fingerprint |
| Account id, **only** at signup, to end the funnel | Passwords, interview answers, personal statements, resumes, messages |

It is first-party only: nothing is sent to any third party, no data leaves the
Supabase project, and the cookies are useless to anyone who obtains them —
they are random numbers that mean something only in our own database.

The `analytics_events` table has a `CHECK` constraint allowing exactly two
event kinds, `page_view` and `signup`, so no future change can quietly start
recording content. A verification query asserts that no column named `ip`,
`email`, `user_agent` or similar exists.

## 3. Does this need a consent banner?

Three things are true at once:

1. **A privacy policy is required regardless of Phase 3.** California's Online
   Privacy Protection Act (CalOPPA) requires any commercial website that
   collects personal information from California residents to post one
   conspicuously. It has no revenue threshold. The site collects email
   addresses and takes payments, so it is in scope today.

2. **The stricter California law probably does not apply yet.** CPRA's
   obligations attach above thresholds — roughly $25M revenue, 100,000
   consumers, or half of revenue from selling data. At ~$5.8k lifetime revenue
   and ~634 accounts, the site is far below all three. This is worth
   re-checking as it grows.

3. **EU/UK visitors are the open question.** ePrivacy requires consent before
   setting a non-essential cookie, and an analytics cookie is not "strictly
   necessary". The audience is US nurses, but the site is reachable from
   anywhere. The Google and TikTok pixels already raise this and raise it
   harder, because they share data with third parties for advertising.

### Your options

| Option | What it means | My view |
|---|---|---|
| **A. Publish a privacy policy. No banner.** | Policy page, linked in the footer. First-party analytics runs for everyone. Existing pixels keep running. | **Recommended as the first step.** It closes the CalOPPA gap, is honest with users, and is proportionate to a US-focused site. It does not resolve the EU question. |
| **B. Policy plus a consent banner** | Non-essential cookies — mine *and* the two ad pixels — wait for consent. | The most defensible, and the most work. It would change how the ad pixels fire, which is a change to advertising I will not make without you asking for it. |
| **C. Policy, no banner, and do not track EU visitors** | Skip tracking when the visitor is in the EU/UK. | A middle path, but it needs IP geolocation — which means handling the one identifier I deliberately avoided. I do not recommend it. |

Independently of A/B/C: **decide whether to keep sending registrants' email
addresses to TikTok.** If you keep it, the policy must say so plainly.

The tracker already honours the browser's Do Not Track signal and never tracks
`/admin`, whichever option you choose.

## 4. Draft privacy notice

Ready to use as the body of a `/privacy` page. Square brackets are yours to
fill in or cut.

> ## Privacy Policy
>
> Last updated: [DATE]
>
> CRNA Prep Hub ("we", "us") provides CRNA school research and interview
> preparation tools. This policy explains what we collect, why, and what you
> can do about it.
>
> ### Information you give us
>
> - **Account details.** Your email address and a password, when you register.
>   Passwords are stored by our authentication provider (Supabase) as salted
>   hashes; we never see or store your password.
> - **Content you create.** Mock interview answers, personal statements,
>   resumes, GPA figures and messages you send us. This is yours. We do not
>   sell it, share it with advertisers, or use it to train third-party AI
>   models. [Add here if AI features send content to a model provider — if the
>   interview or resume tools call an external API, that belongs in this
>   paragraph.]
> - **Payment details.** Payments are processed by Stripe. We never receive or
>   store your card number. We keep a record of what was purchased and when.
>
> ### Information we collect automatically
>
> We keep our own basic record of how the site is used, so we can see which
> pages help people and where our visitors come from. We store:
>
> - a random identifier in a cookie on your device, which identifies a browser
>   and not a person;
> - which pages were viewed, and in what order;
> - the website that referred you (for example `google.com`), and any campaign
>   tag in the link you followed;
> - whether you were on a phone, tablet or computer, and which browser family.
>
> We do **not** store your IP address, and we do not use fingerprinting or any
> other technique to identify you across websites. If you create an account, we
> link that browser identifier to your account so we can understand how people
> find us. You can clear this at any time by clearing your cookies.
>
> If your browser sends a "Do Not Track" signal, we do not record anything.
>
> ### Advertising
>
> We advertise on TikTok and Google. Both place their own cookies on your
> device and receive information about your visit, including pages you view.
> [If you keep the server-side event: We also tell TikTok when someone
> registers, which includes the email address used.] This is governed by their
> own privacy policies:
>
> - Google: https://policies.google.com/privacy
> - TikTok: https://www.tiktok.com/legal/privacy-policy
>
> You can opt out of personalised Google advertising at
> https://adssettings.google.com.
>
> ### Cookies we set
>
> | Cookie | Purpose | Lasts |
> |---|---|---|
> | Authentication cookies | Keep you signed in | Session / 30 days |
> | `cph_vid` | A random id so we can count returning visitors | 180 days |
> | `cph_sid` | A random id that groups one visit together | 30 minutes |
>
> Third-party advertising cookies are set by Google and TikTok as described
> above.
>
> ### How long we keep things
>
> Usage records are deleted after [400] days. Your account content is kept
> until you ask us to delete it.
>
> ### Your choices
>
> Email [YOUR EMAIL] to request a copy of your data, correct it, or delete your
> account and its content. We will respond within 30 days. You can clear
> analytics cookies at any time in your browser settings.
>
> ### Children
>
> This service is for adults pursuing graduate nursing education and is not
> directed at anyone under 18.
>
> ### Changes
>
> We will update the date at the top of this page when this policy changes.
>
> ### Contact
>
> [YOUR EMAIL]

## 5. What I have and have not done

**Done:** the tracker is written, tested and **switched off**. It does nothing
until `NEXT_PUBLIC_ANALYTICS_TRACKING=on` is set, which is a deliberate second
decision after this review.

**Not done, because it needs your approval:**

- No `/privacy` route has been created. The draft above is a document, not a
  live page — publishing a privacy policy is a statement to your users and
  yours to make.
- No consent banner. It would change how the existing ad pixels fire.
- No footer or navigation link.
- No change to the TikTok or Google pixels, or to `/api/tiktok-event`.
- The migration has not been applied.
