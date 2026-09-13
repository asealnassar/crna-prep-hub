import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, readAccessToken } from '@/lib/apiAuth'
import {
  AI_RATE_LIMITS, RATE_LIMIT_CODE, checkAiRate, rateLedgerWindowMs,
} from '@/lib/resume/entitlement'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

/**
 * ABUSE PROTECTION, ADDED IN PHASE 12. This route is V1's, and it stays live
 * for the rollback window after V2 becomes the live builder -- at which point
 * no page links to it any more, and it remains perfectly callable. It had a
 * session check and nothing else: any signed-in user could call GPT-4o without
 * limit, and because the ICU fields are interpolated into the prompt, with
 * arbitrary text. That made it an unmetered language model behind a login.
 *
 * The fix is the ceiling the V2 routes already use -- the same windows, the
 * same ledger, the same silence about it. There is no quota to display and no
 * upgrade to offer: a 429 here means "try again shortly" and nothing else.
 *
 * NO SERVICE ROLE. The ledger is reached with the caller's own JWT, so RLS
 * decides what they can read, and record_ai_usage writes the row for
 * auth.uid(). Nothing here can see or touch another user's usage.
 *
 * Nothing else about V1's behaviour is changed.
 */

/** The caller's own recent AI calls, from the shared ledger. */
async function rateDecision(db: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - rateLedgerWindowMs()).toISOString()
  const { data, error } = await db
    .from('resume_ai_usage')
    .select('created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    // Fail closed: an abuse control that opens when its storage misbehaves is
    // not a control.
    console.error('resume enhance: usage ledger unreadable', error.code, error.message)
    return {
      allowed: false as const,
      retryAfterSeconds: 30,
      message: 'Too many requests just now. Please try again shortly.',
    }
  }

  const recent = (data ?? [])
    .map((row) => Date.parse((row as { created_at: string }).created_at))
    .filter((at) => Number.isFinite(at))
  return checkAiRate(recent, Date.now(), AI_RATE_LIMITS)
}

async function recordAttempt(db: SupabaseClient): Promise<string | null> {
  // No resume id: this route is given a position from the request body and
  // never reads a stored resume, so there is nothing to attribute it to.
  const { data, error } = await db.rpc('record_ai_usage', {
    p_resume_id: null,
    p_operation: 'v1-enhance-bullets',
    p_outcome: 'attempted',
  })
  if (error) {
    console.error('resume enhance: could not record usage', error.code, error.message)
    return null
  }
  return typeof data === 'string' ? data : null
}

async function settle(db: SupabaseClient, usageId: string | null, outcome: string): Promise<void> {
  if (!usageId) return
  const { error } = await db.rpc('settle_ai_usage', { p_id: usageId, p_outcome: outcome })
  if (error) console.error('resume enhance: could not settle usage', error.code, error.message)
}

export async function POST(request: NextRequest) {
  try {
    // Authorization runs before the body is read and before any OpenAI call,
    // so an unauthorized request costs zero tokens. This route was previously
    // open: an unauthenticated POST returned real GPT-4o output, and the
    // Ultimate branch was unlocked by whatever the caller claimed.
    const auth = await authenticateRequest()
    if (!auth) {
      return NextResponse.json(
        { error: 'You must be signed in to enhance resume bullet points.' },
        { status: 401 }
      )
    }

    // The caller's own JWT, so RLS scopes the ledger read. No service role.
    const token = await readAccessToken()
    if (!token) {
      return NextResponse.json(
        { error: 'You must be signed in to enhance resume bullet points.' },
        { status: 401 }
      )
    }
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    )

    // Checked BEFORE the model call, so a refused request costs nothing. The
    // message names no plan and no allowance, because there is no quota.
    const rate = await rateDecision(db, auth.userId)
    if (!rate.allowed) {
      return NextResponse.json(
        { error: RATE_LIMIT_CODE, message: rate.message },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
      )
    }

    const { icuPosition } = await request.json()

    // Read from the database via the verified session, never from the request
    // body. A client claiming userTier: 'ultimate' has no effect here.
    const isUltimate = auth.isUltimate

    // Build context from ICU position data
    const context = {
      unit_type: icuPosition.unit_type,
      hospital: icuPosition.hospital,
      acuity: icuPosition.acuity,
      devices: icuPosition.devices || [],
      patient_population: icuPosition.patient_population || [],
      start_date: icuPosition.start_date,
      end_date: icuPosition.end_date,
      is_current: icuPosition.is_current
    }

    // Calculate years of experience
    const startDate = new Date(context.start_date)
    const endDate = context.is_current ? new Date() : new Date(context.end_date)
    const years = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365)
    const yearsExperience = Math.max(0.5, Math.round(years * 10) / 10)

    const prompt = `You are an expert CRNA school admissions consultant. Create ${isUltimate ? '5-6' : '3-4'} EXCEPTIONAL resume bullet points that will get this ICU nurse accepted into top CRNA programs.

Context:
- Unit: ${context.unit_type}
- Hospital: ${context.hospital}
- Acuity: ${context.acuity}
- Years of Experience: ${yearsExperience} years
- Devices/Skills: ${context.devices.join(', ')}
- Patient Population: ${context.patient_population.join(', ')}

═══════════════════════════════════════════════════════════════
CRITICAL: EVERY BULLET MUST FOLLOW THIS EXACT STRUCTURE:
ACTION VERB + SKILL/INTERVENTION + PATIENT ACUITY + CLINICAL DECISION-MAKING + MEASURABLE OUTCOME
═══════════════════════════════════════════════════════════════

MANDATORY REQUIREMENTS FOR EVERY BULLET:

1. **START WITH POWERFUL ACTION VERBS** (choose from these ONLY):
   - Managed, Administered, Titrated, Optimized, Coordinated, Delivered, Performed, Assessed, Executed, Monitored, Implemented, Facilitated, Led, Directed

2. **ALWAYS INCLUDE PATIENT ACUITY DESCRIPTORS** (use 1-2 per bullet):
   - "critically ill patients"
   - "hemodynamically unstable patients"
   - "patients requiring aggressive intervention"
   - "high-acuity patients with multi-organ dysfunction"
   - "patients in acute decompensation"
   - "patients with life-threatening conditions"
   - "complex critically ill patients"

3. **EMPHASIZE CLINICAL DECISION-MAKING** (include at least one):
   - "through continuous clinical assessment"
   - "utilizing advanced hemodynamic monitoring"
   - "via rapid clinical decision-making"
   - "requiring independent critical thinking"
   - "through expert clinical judgment"
   - "with real-time intervention adjustments"

4. **INCLUDE MEASURABLE OUTCOMES** (every bullet needs one):
   - Specific numbers: "maintaining MAP >65 mmHg"
   - Patient ratios: "for 1-2  critically ill patients"
   - Time frames: "during 12-hour shifts"
   - Success metrics: "optimizing tissue perfusion", "improving hemodynamic stability", "preventing complications", "maintaining oxygenation goals"
   - Intervention frequency: "performing hourly assessments"

5. **NEVER ABBREVIATE MEDICATIONS OR DISEASES:**
   ❌ WRONG: "Levo", "Vaso", "Epi", "Propofol", "Versed", "DKA", "ARDS", "MI"
   ✅ CORRECT: "Norepinephrine", "Vasopressin", "Epinephrine", "Propofol", "Midazolam", "Diabetic Ketoacidosis", "Acute Respiratory Distress Syndrome", "Myocardial Infarction"

6. **NEVER USE PASSIVE OR WEAK LANGUAGE:**
   ❌ AVOID: "Responsible for", "Helped with", "Assisted in", "Was involved in", "Took care of", "Worked with"
   ✅ USE: Direct action statements that show ownership and expertise

═══════════════════════════════════════════════════════════════
EXAMPLES OF PERFECT BULLETS (STUDY THESE):
═══════════════════════════════════════════════════════════════

❌ WEAK (DON'T DO THIS):
"Managed ventilators and titrated medications for ICU patients"

✅ STRONG (DO THIS):
"Managed mechanical ventilation for 8-12 critically ill patients with Acute Respiratory Distress Syndrome, performing arterial blood gas interpretation and ventilator mode adjustments to maintain optimal oxygenation while minimizing ventilator-induced lung injury"

❌ WEAK:
"Administered vasoactive medications"

✅ STRONG:
"Administered and titrated multiple vasoactive infusions (Norepinephrine, Vasopressin, Epinephrine) for hemodynamically unstable patients in septic shock, maintaining mean arterial pressures >65 mmHg through continuous hemodynamic assessment and rapid intervention adjustments"

❌ WEAK:
"Performed CRRT on patients with kidney failure"

✅ STRONG:
"Managed continuous renal replacement therapy for critically ill patients with acute kidney injury and multi-organ dysfunction, optimizing fluid balance and electrolyte management while collaborating with nephrology to prevent complications during prolonged ICU stays"

❌ WEAK:
"Took care of post-op cardiac patients"

✅ STRONG:
"Delivered comprehensive post-operative care for high-acuity cardiac surgery patients requiring intensive hemodynamic monitoring, managing complex medication regimens including inotropic support and anticoagulation while preventing postoperative complications through vigilant clinical assessment"

═══════════════════════════════════════════════════════════════
ANESTHESIA-RELEVANT SKILLS TO EMPHASIZE:
═══════════════════════════════════════════════════════════════

If their experience includes these, HEAVILY emphasize them:
- Airway management and rapid sequence intubation assistance
- Advanced hemodynamic monitoring (Swan-Ganz, arterial lines, FloTrac)
- Complex pharmacology (vasoactive medications, sedation, paralytics)
- Mechanical ventilation expertise (modes, weaning, troubleshooting)
- Code Blue leadership and ACLS interventions
- Blood product administration and massive transfusion protocols
- Arterial blood gas interpretation and ventilator adjustments
- Collaboration with anesthesia teams during procedures

═══════════════════════════════════════════════════════════════
TIER-SPECIFIC INSTRUCTIONS:
═══════════════════════════════════════════════════════════════

${isUltimate ? `
ULTIMATE TIER - CREATE EXCEPTIONAL BULLETS:
- Include SPECIFIC procedures and protocols by name
- Add collaboration with anesthesia/critical care teams
- Include complex patient scenarios (multi-organ failure, ECMO, IABP)
- Reference advanced monitoring techniques
- Add measurable clinical outcomes
- Include teaching/mentoring if applicable
- Length: 2-3 lines each (very detailed and comprehensive)
` : `
PREMIUM TIER - CREATE STRONG BULLETS:
- Focus on core ICU competencies
- Emphasize anesthesia-relevant skills
- Include patient acuity and outcomes
- Length: 1.5-2 lines each (detailed but concise)
`}

═══════════════════════════════════════════════════════════════
FORMAT REQUIREMENTS:
═══════════════════════════════════════════════════════════════

- Each bullet: 1.5-2.5 lines (Ultimate: up to 3 lines)
- NO special characters, symbols, or emojis
- Professional, confident tone
- ATS-friendly formatting
- Each bullet is a complete, standalone statement

Return ONLY a JSON object with this structure:
{
  "bullets": [
    "First amazing bullet point here...",
    "Second amazing bullet point here...",
    ...
  ]
}

NO markdown formatting. NO explanations. NO preamble. ONLY the JSON object.`

    // Recorded immediately before the call, so the ledger counts attempts
    // rather than successes -- a run of failures must not be a free retry loop.
    const usageId = await recordAttempt(db)

    let completion
    try {
      completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.75,
        max_tokens: 1200,
        response_format: { type: 'json_object' }
      })
    } catch (modelError) {
      await settle(db, usageId, 'failed')
      throw modelError
    }

    const result = JSON.parse(completion.choices[0].message.content || '{"bullets": []}')
    
    // Normalize the response
    const bullets = result.bullets || result.bullet_points || Object.values(result)

    await settle(db, usageId, 'proposed')

    return NextResponse.json({ bullets })
  } catch (error: any) {
    console.error('AI Enhancement Error:', error)
    return NextResponse.json(
      { error: 'Failed to enhance resume. Please try again.' },
      { status: 500 }
    )
  }
}
