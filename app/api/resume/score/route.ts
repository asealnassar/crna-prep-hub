import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { resumeId } = await request.json()

    // Get all resume sections
    const { data: sections } = await supabase
      .from('resume_sections')
      .select('*')
      .eq('resume_id', resumeId)

    if (!sections) {
      return NextResponse.json({ error: 'Resume not found' }, { status: 404 })
    }

    // Extract section data
    const educationData = sections.find(s => s.section_type === 'education')?.section_data || {}
    const certificationsData = sections.find(s => s.section_type === 'certifications')?.section_data || {}
    const icuData = sections.find(s => s.section_type === 'icu_experience')?.section_data || {}
    const shadowingData = sections.find(s => s.section_type === 'shadowing')?.section_data || {}
    const leadershipData = sections.find(s => s.section_type === 'leadership')?.section_data || {}
    const researchData = sections.find(s => s.section_type === 'research')?.section_data || {}

    // Calculate scores
    let icu_score = 0
    let cert_score = 0
    let shadow_score = 0
    let leadership_score = 0
    let education_score = 0
    let research_score = 0

    // ICU Experience (30 points max)
    if (icuData.positions?.length > 0) {
      const position = icuData.positions[0]
      
      // Calculate years of experience
      const startDate = new Date(position.start_date)
      const endDate = position.is_current ? new Date() : new Date(position.end_date)
      const years = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365)
      
      // Years: up to 15 points (3 points per year, max 5 years)
      icu_score += Math.min(Math.floor(years * 3), 15)
      
      // Acuity: 5 points
      if (position.acuity === 'high') icu_score += 5
      else if (position.acuity === 'medium') icu_score += 3
      
      // Devices: up to 10 points (1 point each, max 10)
      const deviceCount = position.devices?.length || 0
      icu_score += Math.min(deviceCount, 10)
      
      // Multiple positions bonus: 2 points
      if (icuData.positions.length > 1) icu_score += 2
    }

    // Certifications (20 points max)
    const certs = certificationsData.certifications || []
    if (certs.includes('CCRN')) cert_score += 10
    if (certs.includes('ACLS')) cert_score += 3
    if (certs.includes('BLS')) cert_score += 2
    if (certs.includes('PALS')) cert_score += 3
    if (certs.includes('TNCC')) cert_score += 2

// Shadowing (15 points max)
    if (shadowingData.experiences && shadowingData.experiences.length > 0) {
      // Calculate total hours across all experiences
      const totalHours = shadowingData.experiences.reduce((sum: number, exp: any) => {
        return sum + (parseInt(exp.hours) || 0)
      }, 0)
      
      if (totalHours >= 40) shadow_score = 15
      else if (totalHours >= 20) shadow_score = 10
      else if (totalHours >= 10) shadow_score = 5
      else if (totalHours > 0) shadow_score = 2
    }
    // Leadership (15 points max)
    const leadershipRoles = leadershipData.roles?.length || 0
    leadership_score = Math.min(leadershipRoles * 5, 15)

// Education (10 points max)
    const nursingDegree = educationData.nursing_degree?.degree
    if (nursingDegree === 'MSN' || nursingDegree === 'DNP') education_score = 10
    else if (nursingDegree === 'BSN') education_score = 8
    else education_score = 5

    // GPA bonus
    const scienceGPA = parseFloat(educationData.nursing_degree?.science_gpa || '0')
    if (scienceGPA >= 3.5) education_score = Math.min(education_score + 2, 10)
    // Research/QI (10 points max)
    const projectCount = researchData.projects?.filter((p: string) => p.trim()).length || 0
    research_score = Math.min(projectCount * 5, 10)

    const overall_score = icu_score + cert_score + shadow_score + leadership_score + education_score + research_score

    // Generate suggestions
    const suggestions = []
    const redFlags = []

    if (!certs.includes('CCRN')) {
      suggestions.push({
        priority: 1,
        impact: '+10 points',
        suggestion: 'Get CCRN certified - this is essential for competitive CRNA applications'
      })
      redFlags.push({
        severity: 'high',
        message: 'Missing CCRN certification - required by most programs'
      })
    }

const totalShadowingHours = shadowingData.experiences?.reduce((sum: number, exp: any) => {
      return sum + (parseInt(exp.hours) || 0)
    }, 0) || 0

    if (!shadowingData.experiences || shadowingData.experiences.length === 0 || totalShadowingHours < 20) {
      suggestions.push({
        priority: 2,
        impact: '+10 points',
        suggestion: 'Shadow a CRNA for at least 20 hours to demonstrate genuine interest'
      })
      if (!shadowingData.experiences || shadowingData.experiences.length === 0) {
        redFlags.push({
          severity: 'high',
          message: 'No CRNA shadowing experience - demonstrates lack of exposure to the role'
        })
      }
    }
    if (icu_score < 20) {
      suggestions.push({
        priority: 3,
        impact: '+5-10 points',
        suggestion: 'Gain more high-acuity ICU experience with advanced devices (ECMO, IABP, CRRT)'
      })
    }

    if (leadership_score === 0) {
      suggestions.push({
        priority: 4,
        impact: '+5 points',
        suggestion: 'Take on a leadership role (charge nurse, preceptor, committee member)'
      })
    }

    // Save score to database
    const { data: existingScore } = await supabase
      .from('resume_scores')
      .select('id')
      .eq('resume_id', resumeId)
      .single()

    const scoreData = {
      resume_id: resumeId,
      overall_score,
      icu_experience_score: icu_score,
      certifications_score: cert_score,
      shadowing_score: shadow_score,
      leadership_score: leadership_score,
      education_score: education_score,
      research_score: research_score,
      suggestions: suggestions.slice(0, 3), // Top 3
      red_flags: redFlags
    }

    if (existingScore) {
      await supabase
        .from('resume_scores')
        .update(scoreData)
        .eq('id', existingScore.id)
    } else {
      await supabase
        .from('resume_scores')
        .insert(scoreData)
    }

    // Update resume overall score
    await supabase
      .from('resumes')
      .update({ overall_score })
      .eq('id', resumeId)

    return NextResponse.json({
      overall_score,
      breakdown: {
        icu_experience_score: icu_score,
        certifications_score: cert_score,
        shadowing_score: shadow_score,
        leadership_score: leadership_score,
        education_score: education_score,
        research_score: research_score
      },
      suggestions,
      red_flags: redFlags
    })
  } catch (error: any) {
    console.error('Scoring Error:', error)
    return NextResponse.json(
      { error: 'Failed to score resume. Please try again.' },
      { status: 500 }
    )
  }
}
