import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

// Use service role client for API routes
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function POST(request: NextRequest) {
  console.log('🔔 Email notification API called!')
  try {
    const { recipientId, senderName, messagePreview } = await request.json()
    console.log('📧 Sending to:', recipientId, senderName)
    
    // Get recipient email
    const { data: recipient } = await supabase
      .from('user_profiles')
      .select('email')
      .eq('id', recipientId)
      .single()

    console.log('👤 Recipient found:', recipient?.email)

    if (!recipient?.email) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 })
    }

    // Send email
    console.log('📮 Sending email via Resend...')
    const result = await resend.emails.send({
from: 'CRNA Prep Hub <notifications@crnaprephub.com>',
      to: recipient.email,
      subject: 'New Message from CRNA Prep Hub',
html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
          <!-- Header -->
          <div style="background: linear-gradient(to right, #7c3aed, #ec4899); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">CRNA Prep Hub</h1>
            <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Your Path to CRNA School Success</p>
          </div>
          
          <!-- Message Content -->
          <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
            <h2 style="color: #7c3aed; margin-top: 0;">You have a new message!</h2>
            <p style="color: #6b7280;"><strong>From:</strong> ${senderName}</p>
            
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #7c3aed;">
              <p style="margin: 0; color: #374151; line-height: 1.6;">${messagePreview}</p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="https://crnaprephub.com/dashboard" 
                 style="background: linear-gradient(to right, #7c3aed, #ec4899); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; font-size: 16px;">
                View Full Message →
              </a>
            </div>
            
            <!-- Features Section -->
            <div style="border-top: 2px solid #e5e7eb; margin-top: 40px; padding-top: 30px;">
              <h3 style="color: #1f2937; font-size: 18px; margin-bottom: 20px;">What's on CRNA Prep Hub:</h3>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">🏫</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">149+ CRNA Programs</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Searchable database with filters for GPA, tuition, location & more</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">🎤</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">AI Mock Interviews</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Practice with instant feedback and realistic CRNA interview questions</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">📄</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">Resume Builder</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Create professional CRNA resumes with AI-enhanced bullet points</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">📊</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">GPA Calculator</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Calculate cumulative, science, and nursing GPAs with semester tracking</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">✍️</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">Personal Statement Analyzer</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Get AI feedback and suggestions to improve your application essay</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">📚</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">School-Specific Prep</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Learn each program's unique interview style and format</p>
                </div>
              </div>
            </div>
            
            <!-- Footer -->
            <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 2px solid #e5e7eb;">
              <p style="color: #9ca3af; font-size: 14px; margin: 5px 0;">
                <a href="https://crnaprephub.com" style="color: #7c3aed; text-decoration: none;">crnaprephub.com</a>
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 5px 0;">
                Your complete resource for CRNA school preparation
              </p>
            </div>
          </div>
        </div>
      `
    })

    console.log('✅ Email sent successfully:', result)
    return NextResponse.json({ success: true, result })
  } catch (error: any) {
    console.error('❌ Email notification error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
