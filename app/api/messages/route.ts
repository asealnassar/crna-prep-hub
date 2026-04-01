import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(request: NextRequest) {
  try {
    const { recipientId, senderName, messagePreview } = await request.json()
    
    const supabase = createClient()
    
    // Get recipient email
    const { data: recipient } = await supabase
      .from('user_profiles')
      .select('email')
      .eq('id', recipientId)
      .single()

    if (!recipient?.email) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 })
    }

    // Send email
    await resend.emails.send({
      from: 'CRNA Prep Hub <notifications@crnaprephub.com>',
      to: recipient.email,
      subject: 'New Message from CRNA Prep Hub',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #7c3aed;">You have a new message!</h2>
          <p><strong>From:</strong> ${senderName}</p>
          <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0;">${messagePreview}</p>
          </div>
          <p>
            <a href="https://crnaprephub.com/dashboard" 
               style="background: linear-gradient(to right, #7c3aed, #ec4899); color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
              View Message
            </a>
          </p>
        </div>
      `
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Email notification error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
