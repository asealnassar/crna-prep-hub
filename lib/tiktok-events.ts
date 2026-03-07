// Send server-side events to TikTok Events API
export async function sendTikTokEvent(
  eventName: string,
  email: string,
  eventData?: {
    value?: number
    currency?: string
    content_name?: string
  }
) {
  const pixelId = process.env.TIKTOK_PIXEL_ID
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN

  if (!pixelId || !accessToken) {
    console.error('TikTok credentials missing')
    return
  }

  // Hash email for privacy (TikTok requires SHA256)
  const crypto = require('crypto')
  const hashedEmail = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex')

  const payload = {
    pixel_code: pixelId,
    event: eventName,
    timestamp: new Date().toISOString(),
    context: {
      user_agent: 'CRNA-Prep-Hub-Server',
      ip: '0.0.0.0', // Will be replaced by TikTok with actual IP
    },
    properties: {
      ...eventData,
    },
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
    console.log(`TikTok Event ${eventName}:`, result)
    return result
  } catch (error) {
    console.error('TikTok Event Error:', error)
  }
}
