import jsPDF from 'jspdf'

export function generateResumePDF(resumeData: any, templateId: string = 'modern') {
  const doc = new jsPDF()
  
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 20
  let yPosition = 20

  // Template-specific settings
  const templates: any = {
    modern: {
      primaryColor: [100, 80, 200] as const,
      accentColor: [139, 92, 246] as const,
      headerSize: 18,
      sectionSize: 12,
      bodySize: 10
    },
    professional: {
      primaryColor: [30, 58, 138] as const,
      accentColor: [59, 130, 246] as const,
      headerSize: 16,
      sectionSize: 11,
      bodySize: 10
    },
    ats: {
      primaryColor: [0, 0, 0] as const,
      accentColor: [75, 85, 99] as const,
      headerSize: 16,
      sectionSize: 11,
      bodySize: 10
    },
    compact: {
      primaryColor: [17, 24, 39] as const,
      accentColor: [107, 114, 128] as const,
      headerSize: 14,
      sectionSize: 10,
      bodySize: 9
    },
    creative: {
      primaryColor: [219, 39, 119] as const,
      accentColor: [236, 72, 153] as const,
      headerSize: 18,
      sectionSize: 12,
      bodySize: 10
    }
  }

  const template = templates[templateId] || templates.modern

  // Helper to add section header
  const addSectionHeader = (title: string) => {
    yPosition += 5
    doc.setFontSize(template.sectionSize)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...(template.primaryColor as [number, number, number]))
    doc.text(title.toUpperCase(), margin, yPosition)
    yPosition += 2
    doc.setDrawColor(...(template.accentColor as [number, number, number]))
    doc.setLineWidth(0.5)
    doc.line(margin, yPosition, pageWidth - margin, yPosition)
    yPosition += 6
    doc.setTextColor(0, 0, 0)
  }

  // Helper to add bullet point
  const addBullet = (text: string) => {
    doc.setFontSize(template.bodySize)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(0, 0, 0)
    const lines = doc.splitTextToSize(text, pageWidth - margin - 30)
    doc.text('•', margin + 5, yPosition)
    doc.text(lines, margin + 10, yPosition)
    yPosition += lines.length * (template.bodySize * 0.5)
  }

  // Check if we need a new page
  const checkPageBreak = (spaceNeeded: number = 20) => {
    if (yPosition + spaceNeeded > pageHeight - 20) {
      doc.addPage()
      yPosition = 20
    }
  }

  // === HEADER (Personal Info) ===
  const personal = resumeData.personal || {}
  
  if (templateId === 'creative') {
    // Creative template: Colored header bar
    doc.setFillColor(...(template.primaryColor as [number, number, number]))
    doc.rect(0, 0, pageWidth, 40, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(template.headerSize)
    doc.setFont('helvetica', 'bold')
    const nameWidth = doc.getTextWidth(personal.full_name || 'Name')
    doc.text(personal.full_name || 'Name', (pageWidth - nameWidth) / 2, 20)
    
    doc.setFontSize(template.bodySize)
    doc.setFont('helvetica', 'normal')
    let contactLine = ''
    if (personal.city) contactLine += `${personal.city}, ${personal.state}`
    if (personal.phone) contactLine += ` • ${personal.phone}`
    if (personal.email) contactLine += ` • ${personal.email}`
    const contactWidth = doc.getTextWidth(contactLine)
    doc.text(contactLine, (pageWidth - contactWidth) / 2, 30)
    
    yPosition = 50
    doc.setTextColor(0, 0, 0)
  } else {
    // Standard templates
    doc.setFontSize(template.headerSize)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...(template.primaryColor as [number, number, number]))
    const nameWidth = doc.getTextWidth(personal.full_name || 'Name')
    doc.text(personal.full_name || 'Name', (pageWidth - nameWidth) / 2, yPosition)
    yPosition += template.headerSize * 0.6

    doc.setFontSize(template.bodySize)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(0, 0, 0)
    let contactLine = ''
    if (personal.city) contactLine += `${personal.city}, ${personal.state}`
    if (personal.phone) contactLine += ` • ${personal.phone}`
    if (personal.email) contactLine += ` • ${personal.email}`
    if (personal.linkedin) contactLine += ` • ${personal.linkedin}`
    
    const contactWidth = doc.getTextWidth(contactLine)
    doc.text(contactLine, (pageWidth - contactWidth) / 2, yPosition)
    yPosition += 10
  }

  // === PROFESSIONAL SUMMARY ===
  if (personal.professional_summary && personal.professional_summary.trim()) {
    yPosition += 3
    doc.setFontSize(template.sectionSize)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...(template.primaryColor as [number, number, number]))
    const summaryTitleWidth = doc.getTextWidth('PROFESSIONAL SUMMARY')
    doc.text('PROFESSIONAL SUMMARY', (pageWidth - summaryTitleWidth) / 2, yPosition)
    yPosition += 6

    doc.setFontSize(template.bodySize)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(0, 0, 0)
    const summaryLines = doc.splitTextToSize(personal.professional_summary, pageWidth - 2 * margin - 20)
    summaryLines.forEach((line: string) => {
      doc.text(line, margin + 10, yPosition)
      yPosition += template.bodySize * 0.5
    })
    yPosition += 5
  }

  // === EDUCATION ===
  const education = resumeData.education || {}
  if (education.nursing_degree) {
    addSectionHeader('EDUCATION')
    
    doc.setFontSize(template.bodySize + 1)
    doc.setFont('helvetica', 'bold')
    doc.text(`${education.nursing_degree.degree} - Nursing`, margin, yPosition)
    yPosition += 5

    doc.setFontSize(template.bodySize)
    doc.setFont('helvetica', 'normal')
    doc.text(education.nursing_degree.university || '', margin, yPosition)
    yPosition += 5

    const gradDate = education.nursing_degree.graduation_date 
      ? new Date(education.nursing_degree.graduation_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : ''
    doc.text(`Graduated: ${gradDate}`, margin, yPosition)
    yPosition += 4

    if (education.nursing_degree.overall_gpa || education.nursing_degree.science_gpa) {
      let gpaLine = ''
      if (education.nursing_degree.overall_gpa) gpaLine += `Overall GPA: ${education.nursing_degree.overall_gpa}`
      if (education.nursing_degree.overall_gpa && education.nursing_degree.science_gpa) gpaLine += ' | '
      if (education.nursing_degree.science_gpa) gpaLine += `Science GPA: ${education.nursing_degree.science_gpa}`
      doc.text(gpaLine, margin, yPosition)
      yPosition += 5
    }

    // Other Degrees
    if (education.other_degrees?.length > 0) {
      education.other_degrees.forEach((degree: any) => {
        checkPageBreak(25)
        yPosition += 3

        doc.setFontSize(template.bodySize + 1)
        doc.setFont('helvetica', 'bold')
        doc.text(`${degree.degree} - ${degree.field}`, margin, yPosition)
        yPosition += 5

        doc.setFontSize(template.bodySize)
        doc.setFont('helvetica', 'normal')
        doc.text(degree.university || '', margin, yPosition)
        yPosition += 5
      })
    }

    yPosition += 3
  }

  // === CERTIFICATIONS ===
  const certifications = resumeData.certifications || {}
  const allCerts = [
    ...(certifications.certifications || []),
    ...(certifications.custom_certifications || []).filter((c: string) => c.trim())
  ]
  
  if (allCerts.length > 0) {
    checkPageBreak()
    addSectionHeader('CERTIFICATIONS')
    
    doc.setFontSize(template.bodySize)
    doc.setFont('helvetica', 'normal')
    doc.text(allCerts.join(' | '), margin, yPosition)
    yPosition += 8
  }

  // === CRITICAL CARE EXPERIENCE ===
  const icuPositions = resumeData.icu_experience?.positions || []
  if (icuPositions.length > 0) {
    checkPageBreak()
    addSectionHeader('CRITICAL CARE EXPERIENCE')

    icuPositions.forEach((position: any) => {
      checkPageBreak(30)

      // Position header
      doc.setFontSize(template.bodySize + 1)
      doc.setFont('helvetica', 'bold')
      doc.text(position.position || 'ICU Registered Nurse', margin, yPosition)
      
      // Dates (right aligned)
      const startDate = new Date(position.start_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      const endDate = position.is_current ? 'Present' : new Date(position.end_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
      const dateText = `${startDate} - ${endDate}`
      const dateWidth = doc.getTextWidth(dateText)
      doc.setFontSize(template.bodySize)
      doc.setFont('helvetica', 'normal')
      doc.text(dateText, pageWidth - margin - dateWidth, yPosition)
      yPosition += 5

      // Hospital & Location
      doc.setFontSize(template.bodySize)
      doc.text(`${position.hospital}, ${position.location}`, margin, yPosition)
      yPosition += 4

      doc.setFont('helvetica', 'italic')
      doc.text(position.unit_type || '', margin, yPosition)
      yPosition += 6

      doc.setFont('helvetica', 'normal')
      
      // Bullet points
      if (position.bullet_points && position.bullet_points.length > 0) {
        position.bullet_points.forEach((bullet: string) => {
          checkPageBreak(15)
          addBullet(bullet)
        })
      } else {
        if (position.devices?.length > 0) {
          const devicesText = `Skills & Equipment: ${position.devices.join(', ')}`
          checkPageBreak(15)
          addBullet(devicesText)
        }
        if (position.patient_population?.length > 0) {
          const popText = `Patient Population: ${position.patient_population.join(', ')}`
          checkPageBreak(15)
          addBullet(popText)
        }
      }

      yPosition += 4
    })
  }

  // === SHADOWING ===
  const shadowing = resumeData.shadowing || {}
  if (shadowing.experiences?.length > 0) {
    checkPageBreak()
    addSectionHeader('CRNA SHADOWING EXPERIENCE')

    shadowing.experiences.forEach((experience: any) => {
      checkPageBreak(20)

      doc.setFontSize(template.bodySize + 1)
      doc.setFont('helvetica', 'bold')
      doc.text(`Shadowed ${experience.crna_name}`, margin, yPosition)
      yPosition += 5

      doc.setFontSize(template.bodySize)
      doc.setFont('helvetica', 'normal')
      doc.text(`${experience.hours} hours | ${experience.setting}`, margin, yPosition)
      yPosition += 5

      if (experience.description) {
        const lines = doc.splitTextToSize(experience.description, pageWidth - 2 * margin)
        doc.text(lines, margin, yPosition)
        yPosition += lines.length * (template.bodySize * 0.5) + 3
      }
    })

    // Total hours
    const totalHours = shadowing.experiences.reduce((sum: number, exp: any) => sum + (parseInt(exp.hours) || 0), 0)
    doc.setFont('helvetica', 'bold')
    doc.text(`Total Shadowing Hours: ${totalHours}`, margin, yPosition)
    yPosition += 6
  }

  // === LEADERSHIP ===
  const leadership = resumeData.leadership?.roles || []
  if (leadership.length > 0) {
    checkPageBreak()
    addSectionHeader('LEADERSHIP & PROFESSIONAL DEVELOPMENT')

    leadership.forEach((role: string) => {
      checkPageBreak(10)
      addBullet(role)
    })
    yPosition += 3
  }

  // === RESEARCH ===
  const research = resumeData.research?.projects?.filter((p: string) => p.trim()) || []
  if (research.length > 0) {
    checkPageBreak()
    addSectionHeader('RESEARCH & QUALITY IMPROVEMENT')

    research.forEach((project: string) => {
      checkPageBreak(15)
      addBullet(project)
    })
  }

  return doc
}
