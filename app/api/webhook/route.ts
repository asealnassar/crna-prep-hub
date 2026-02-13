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
      const { data: userData } = await supabase.auth.admin.listUsers()
      const user = userData?.users?.find(u => u.email === userEmail)

      if (user) {
        const { error } = await supabase
          .from('user_profiles')
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
