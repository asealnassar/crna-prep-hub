import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { authenticateRequest } from '@/lib/apiAuth'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: NextRequest) {
  try {
    // Authorization runs before the body is read and before any OpenAI call,
    // so an unauthorized request costs zero tokens.
    const auth = await authenticateRequest()
    if (!auth) {
      return NextResponse.json(
        { error: 'You must be signed in to analyze a statement.' },
        { status: 401 }
      )
    }

    const { statement } = await request.json()

    if (!statement || statement.trim().length < 100) {
      return NextResponse.json(
        { error: 'Statement must be at least 100 characters long' },
        { status: 400 }
      )
    }

    // Read from the database via the verified session, never from the request
    // body. A client claiming userTier: 'ultimate' has no effect here.
    const isUltimate = auth.isUltimate

    const systemPrompt = `You are a critical CRNA admissions consultant analyzing personal statements. Be HONEST and DIRECT - don't sugarcoat weaknesses. Provide specific, actionable feedback.

Analyze this personal statement across these categories (score 1-10 for each category):
1. Hook Strength - Does the opening grab attention?
2. Motivation for CRNA - Is the "why CRNA" clear and compelling?
3. Clinical Depth - Are clinical experiences detailed and meaningful?
4. Personal Uniqueness - Does this stand out from other applicants?
5. Structure & Flow - Is it well-organized and easy to read?
6. Red Flags - Any concerning elements (negativity, excuses, unprofessionalism)?

For each category:
- Give a score (1-10)
- Provide 2-3 sentences of critical feedback
- Suggest ONE specific improvement

Then provide:
- Admissions Committee Impression (2-3 sentences)
- Biggest Weaknesses (top 3)
- Top 3 Changes to Improve Acceptance Chances

${isUltimate ? 'Also identify 5-7 specific sentences that are weak/generic/strong with improved versions.' : ''}

Calculate the overall score as a percentage (0-100) by averaging all category scores and multiplying by 10.

Return ONLY valid JSON in this exact format:
{
  "overallScore": number (0-100 as a percentage),
  "categories": [
    {
      "name": "Hook Strength",
      "score": number,
      "feedback": "string",
      "suggestion": "string"
    }
  ],
  "admissionsImpression": "string",
  "biggestWeaknesses": ["string", "string", "string"],
  "topChanges": ["string", "string", "string"]
  ${isUltimate ? ', "sentenceAnalysis": [{"original": "string", "label": "Weak|Generic|Strong", "improved": "string"}]' : ''}
}`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: statement }
      ],
      temperature: 0.7,
      max_tokens: 2500,
      response_format: { type: 'json_object' }
    })

    const result = JSON.parse(completion.choices[0].message.content || '{}')

    return NextResponse.json({ analysis: result })
  } catch (error: any) {
    console.error('OpenAI Error:', error)
    return NextResponse.json(
      { error: 'Analysis failed. Please try again.' },
      { status: 500 }
    )
  }
}

// Rewrite endpoint
export async function PUT(request: NextRequest) {
  try {
    // Both checks precede the body read and the OpenAI call.
    const auth = await authenticateRequest()
    if (!auth) {
      return NextResponse.json(
        { error: 'You must be signed in to use the rewrite feature.' },
        { status: 401 }
      )
    }

    // Server-side tier check. The hidden UI button was never a control.
    if (!auth.isUltimate) {
      return NextResponse.json(
        { error: 'Rewrite feature is Ultimate only' },
        { status: 403 }
      )
    }

    const { statement, analysis } = await request.json()

    // Build detailed improvement instructions from analysis
    let improvementInstructions = `You are a CRNA admissions expert. Completely rewrite this personal statement to be highly competitive.

CRITICAL IMPROVEMENTS REQUIRED:

Category-Specific Fixes:`

    if (analysis?.categories) {
      analysis.categories.forEach((cat: any) => {
        improvementInstructions += `\n\n${cat.name} (Current: ${cat.score}/10):
- ${cat.suggestion}`
      })
    }

    if (analysis?.topChanges) {
      improvementInstructions += `\n\nTOP 3 MANDATORY CHANGES:\n`
      analysis.topChanges.forEach((change: string, idx: number) => {
        improvementInstructions += `${idx + 1}. ${change}\n`
      })
    }

    if (analysis?.sentenceAnalysis) {
      improvementInstructions += `\n\nSENTENCE-LEVEL IMPROVEMENTS:\n`
      analysis.sentenceAnalysis.forEach((item: any) => {
        if (item.label === 'Weak' || item.label === 'Generic') {
          improvementInstructions += `- Replace: "${item.original}"\n  With: "${item.improved}"\n`
        }
      })
    }

    improvementInstructions += `\n\nADDITIONAL REQUIREMENTS:
- Create a powerful hook that immediately grabs attention
- Make the "why CRNA" motivation crystal clear and compelling
- Add specific clinical examples with concrete details (patients, procedures, outcomes)
- Remove ALL generic phrases and clichés
- Ensure smooth transitions between paragraphs
- Keep the applicant's authentic voice and experiences
- Aim for a score of 90%+ across all categories

Return ONLY the completely rewritten statement (no preamble, no explanation, just the improved essay).`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: improvementInstructions },
        { role: 'user', content: `Original statement:\n\n${statement}` }
      ],
      temperature: 0.8,
      max_tokens: 2500
    })

    return NextResponse.json({ rewritten: completion.choices[0].message.content })
  } catch (error) {
    console.error('Rewrite error:', error)
    return NextResponse.json({ error: 'Rewrite failed' }, { status: 500 })
  }
}
