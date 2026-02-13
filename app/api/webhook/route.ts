import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
})

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  const body = await request.text()
  const sig = request.headers.get('stripe-signature')!

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error('Webhook signature verification failed')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const userEmail = session.customer_email
    const plan = session.metadata?.plan || 'premium'

    if (userEmail) {
      // Get user by email
      const { data: userData } = await supabase.auth.admin.listUsers()
      const user = userData?.users?.find(u => u.email === userEmail)

      if (user) {
        // Update user's tier
        const { error } = await supabase
          .from('profiles')
          .update({ tier: plan })
          .eq('id', user.id)

        if (error) {
          console.error('Failed to update tier:', error)
        } else {
          console.log(`Updated ${userEmail} to ${plan}`)
        }
      }
    }
  }

  return NextResponse.json({ received: true })
}
```

**Press Ctrl+O, Enter, Ctrl+X to save.**

**Step 2: Set up webhook in Stripe:**

1. Go to **Stripe Dashboard** → **Developers** → **Webhooks**
2. Click **Add endpoint**
3. Enter URL: `https://crnaprephub.com/api/webhook`
4. Select event: **checkout.session.completed**
5. Click **Add endpoint**
6. Copy the **Signing secret** (starts with `whsec_`)

**Step 3: Update your .env.local:**
```
nano ~/Desktop/CRNA-Prep-Hub/.env.local
```

Find `STRIPE_WEBHOOK_SECRET=skip` and replace with:
```
STRIPE_WEBHOOK_SECRET=whsec_your_actual_secret_here
