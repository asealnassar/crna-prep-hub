import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { authenticateRequest } from '@/lib/apiAuth'
import { allowsPromotionCode, isPurchasablePlan, resolvePriceId } from '@/lib/checkout'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
 apiVersion: '2023-10-16'
})

export async function POST(request: Request) {
  try {
    const { plan } = await request.json()

    if (!isPurchasablePlan(plan)) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    // The caller's identity comes from their verified session, never from
    // the request body — otherwise anyone could grant a purchase to any
    // email address.
    const auth = await authenticateRequest()
    if (!auth?.email) {
      return NextResponse.json({ error: 'Please log in to upgrade.' }, { status: 401 })
    }

    // The price is looked up server-side from the plan name. The client
    // never gets to supply a Price ID directly.
    const priceId = resolvePriceId(plan)
    if (!priceId) {
      return NextResponse.json({ error: 'Plan is not configured' }, { status: 500 })
    }

    const sessionConfig: Stripe.Checkout.SessionCreateParams = {
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
      customer_email: auth.email,
      // Stripe's own hosted checkout page renders the promo code field when
      // this is true, and Stripe enforces on its side which promotion codes
      // are valid for the product being purchased. There is no custom
      // discount calculation in this app.
      allow_promotion_codes: allowsPromotionCode(plan),
      metadata: {
        plan,
        userEmail: auth.email,
      },
    }

    const session = await stripe.checkout.sessions.create(sessionConfig)

    return NextResponse.json({ url: session.url })
  } catch (error: any) {
    console.error('Checkout error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
