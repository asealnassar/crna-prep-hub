import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export async function POST(request: Request) {
  try {
    const { messages, systemMessage } = await request.json()

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemMessage,
      messages: messages.map((msg: any) => ({
        role: msg.role,
        content: msg.content,
      })),
    })

    const textContent = response.content.find((block: any) => block.type === 'text')
    const message = textContent ? textContent.text : 'Could you please repeat that?'

    return NextResponse.json({ message })
  } catch (error) {
    console.error('Interview API error:', error)
    return NextResponse.json(
      { message: 'Interview service temporarily unavailable. Please try again.' },
      { status: 500 }
    )
  }
}
