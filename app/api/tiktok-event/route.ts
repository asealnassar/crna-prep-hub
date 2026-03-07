import { NextResponse } from 'next/server'
import crypto from 'crypto'

export async function POST(request: Request) {
  const { eventName, email, eventData } = await request.json()

  const pixelId = process.env.TIKTOK_PIXEL_ID
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN

  if (!pixelId || !accessToken) {
    return NextResponse.json({ error: 'TikTok credentials missing' }, { status: 500 })
  }

  // Hash email for privacy
  const hashedEmail = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex')

  const payload = {
    pixel_code: pixelId,
    event: eventName,
    timestamp: new Date().toISOString(),
    context: {
      user_agent: request.headers.get('user-agent') || 'Unknown',
      ip: request.headers.get('x-forwarded-for') || '0.0.0.0',
    },
    properties: eventData || {},
    user: {
      email: hashedEmail,
    },
  }

  try {
    const response = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': accessToken,
      },
      body: JSON.stringify({
        event_source: 'web',
        event_source_id: pixelId,
        data: [payload],
      }),
    })

    const result = await response.json()
    return NextResponse.json(result)
  } catch (error) {
    console.error('TikTok Event Error:', error)
    return NextResponse.json({ error: 'Failed to send event' }, { status: 500 })
  }
}
