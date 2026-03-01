import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const { messages, systemMessage } = await request.json()

    const conversationMessages = [
      { role: 'developer', content: systemMessage },
      ...messages.map((msg: any) => ({
        role: msg.role,
        content: msg.content,
      })),
    ]

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        input: conversationMessages,
        max_output_tokens: 800,
      }),
    })

    const data = await response.json()
    
    if (!response.ok) {
      console.error('OpenAI API error:', data)
      throw new Error(data.error?.message || 'OpenAI API error')
    }

    const messageOutput = data.output?.find((item: any) => item.type === 'message')
    const message = messageOutput?.content?.[0]?.text || 'Could you please repeat that?'

    return NextResponse.json({ message })
  } catch (error) {
    console.error('Interview API error:', error)
    return NextResponse.json(
      { message: 'Interview service temporarily unavailable. Please try again.' },
      { status: 500 }
    )
  }
}
