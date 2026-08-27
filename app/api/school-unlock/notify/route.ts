import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { recipientEmail, schoolName } = await request.json()

    if (!recipientEmail) {
      return NextResponse.json({ error: 'Recipient email required' }, { status: 400 })
    }

    const result = await resend.emails.send({
      from: 'CRNA Prep Hub <notifications@crnaprephub.com>',
      to: recipientEmail,
      subject: `🔓 ${schoolName} is now unlocked!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
          <div style="background: linear-gradient(to right, #7c3aed, #ec4899); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">CRNA Prep Hub</h1>
          </div>
          <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
            <h2 style="color: #7c3aed; margin-top: 0;">🔓 Your school is unlocked!</h2>
            <p style="color: #374151; line-height: 1.6;">Good news — your access request for <strong>${schoolName}</strong> has been approved. You can now view the full interview style, clinical focus, and insider tips for this program.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="https://www.crnaprephub.com/interview-prep"
                 style="background: linear-gradient(to right, #7c3aed, #ec4899); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; font-size: 16px;">
                View ${schoolName} →
              </a>
            </div>
            <p style="color: #9ca3af; font-size: 13px; margin-top: 30px;">This access is permanent — you won't need to request it again.</p>
          </div>
        </div>
      `
    })

    return NextResponse.json({ success: true, result })
  } catch (error: any) {
    console.error('Unlock notification error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
