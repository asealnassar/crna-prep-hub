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
  try {
    const { priceId, userEmail, promoCode, plan } = await request.json()

    let discountAmount = 0
    let promoData = null

    // Check promo code
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promoCode)
        .eq('is_active', true)
        .single()
      
      if (data) {
        promoData = data
        discountAmount = data.discount_amount // in cents
      }
    }

    // Create checkout session with or without discount
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
      customer_email: userEmail,
      metadata: {
        promoCode: promoCode || '',
        plan: plan,
        userEmail: userEmail
      }
    }

    // Apply discount if promo code is valid
    if (promoData && discountAmount > 0) {
      // Create a one-time coupon in Stripe
      const coupon = await stripe.coupons.create({
        amount_off: discountAmount,
        currency: 'usd',
        duration: 'once',
        name: `Promo: ${promoCode}`,
      })

      sessionConfig.discounts = [{ coupon: coupon.id }]

      // Record promo code usage
      await supabase.from('promo_code_usage').insert({
        promo_code_id: promoData.id,
        code: promoCode,
        user_email: userEmail,
        plan_purchased: plan,
        amount_paid: plan === 'premium' ? 2999 - discountAmount : 4999 - discountAmount,
        promoter_name: promoData.promoter_name
      })
    }

    const session = await stripe.checkout.sessions.create(sessionConfig)

    return NextResponse.json({ url: session.url })
  } catch (error) {
    console.error('Checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 })
  }
}
