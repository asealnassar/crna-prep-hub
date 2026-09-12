/**
 * V1 fixtures built to the distribution Phase 0 measured in production.
 *
 * Not invented shapes: seventeen resumes, forty-one ICU positions spread
 * 1x9 / 2x4 / 3x1 / 5x1 / 6x1 / 10x1, every bullet array `['']`, nine bad start
 * dates, six bad graduation dates, one summary of 4,214 characters. The point
 * of matching the real distribution is that a dry run against these fixtures
 * predicts the dry run against the database -- a fixture set of three tidy
 * resumes would prove nothing about the one carrying ten positions.
 *
 * Deterministic: the same call produces the same rows, so a count that changes
 * means the mapper changed.
 */

import type { V1ResumeRow, V1SectionRow } from './mapV1.ts'

/** ICU positions per resume, in order. Sums to 41 across 17 resumes. */
export const POSITION_DISTRIBUTION = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 5, 6, 10]
/** other_degrees per resume: 0x9, 1x4, 2x3, 3x1 = 13. */
const OTHER_DEGREES = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3]
/** shadowing experiences: 0x5, 1x8, 2x3, 3x1. */
const SHADOWING = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3]
/** leadership roles: 0x1, 1x1, 2x3, 3x5, 4x1, 5x4, 6x1, 7x1. */
const LEADERSHIP = [0, 1, 2, 2, 2, 3, 3, 3, 3, 3, 4, 5, 5, 5, 5, 6, 7]
/** research projects: 0x10, 1x6, 2x1. */
const RESEARCH = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2]
/** certifications: 0x1, 2x1, 4x4, 5x8, 6x2, 7x1. */
const CERTIFICATIONS = [0, 2, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 7]

export const RESUME_COUNT = 17
export const TOTAL_POSITIONS = POSITION_DISTRIBUTION.reduce((a, b) => a + b, 0)

/** The real one is 4,214 characters. */
export const LONG_SUMMARY = 'Critical care nurse. '.repeat(201).slice(0, 4_214)

/** Dates V1 actually holds that no parser can read. */
const UNPARSEABLE = ['Spring 2019', 'summer of 2021', 'n/a', '05/2019', 'Jan 2020 - ish', 'TBD']

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

export interface V1Fixture {
  readonly resumes: V1ResumeRow[]
  readonly sections: V1SectionRow[]
}

/**
 * The whole set, or a slice of it.
 *
 * `overrides` is how a test bends one resume without losing the distribution --
 * a duplicate section row, an unknown key, a template nobody recognises.
 */
export function v1Fixtures(overrides: {
  /** Extra section rows appended verbatim, e.g. a duplicate. */
  readonly extraSections?: readonly V1SectionRow[]
  /** Replaces a resume row's template_id by index. */
  readonly templates?: Readonly<Record<number, string>>
} = {}): V1Fixture {
  const resumes: V1ResumeRow[] = []
  const sections: V1SectionRow[] = []
  let sectionSeq = 1000

  for (let i = 0; i < RESUME_COUNT; i++) {
    const resumeId = uuid(i + 1)
    resumes.push({
      id: resumeId,
      user_id: `user-${i < 16 ? i : 15}`, // 17 resumes across 16 owners: one owner holds two.
      title: i === 3 ? '' : `Resume ${i + 1}`,
      template_id: overrides.templates?.[i] ?? ['modern', 'ats', 'compact', 'creative', 'professional'][i % 5],
      created_at: `2025-0${(i % 9) + 1}-01T00:00:00.000Z`,
      updated_at: `2025-1${i % 2}-01T00:00:00.000Z`,
      is_published: false,
      overall_score: i === 2 ? 64 : 0,
    })

    const add = (type: string, data: unknown, order: number) => {
      sections.push({
        id: uuid(sectionSeq++), resume_id: resumeId, section_type: type,
        section_data: data, order_index: order,
      })
    }

    // personal -- 2/17 no name, 3/17 no phone, 16/17 no linkedin, 4/17 no summary
    add('personal', {
      full_name: i < 2 ? '' : `Applicant ${i + 1}`,
      email: `applicant${i + 1}@example.test`,
      phone: i < 3 ? '' : `555-01${String(i).padStart(2, '0')}`,
      city: 'Newark',
      state: 'NJ',
      linkedin: i === 16 ? 'linkedin.com/in/applicant17' : '',
      professional_summary: i < 4 ? '' : i === 4 ? LONG_SUMMARY : `Critical care nurse, resume ${i + 1}.`,
      ...(i === 7 ? { volunteer_work: 'Collected by V1 and never rendered' } : {}),
    }, 0)

    // education -- 6/17 bad graduation dates (4 empty, 2 unparseable);
    // overall_gpa on 12/17; science_gpa on 3/17.
    const badGrad = i < 4 ? '' : i < 6 ? UNPARSEABLE[i % UNPARSEABLE.length] : '2019-05'
    add('education', {
      nursing_degree: {
        degree: 'BSN', field: 'Nursing', university: `University ${i + 1}`,
        graduation_date: badGrad,
        overall_gpa: i < 12 ? `3.${50 + i}` : '',
        science_gpa: i < 3 ? `3.${40 + i}` : '',
      },
      other_degrees: Array.from({ length: OTHER_DEGREES[i] }, (_, d) => ({
        degree: 'BA', field: 'Biology', university: `Other College ${d + 1}`,
        graduation_date: d === 0 ? '2015-06' : UNPARSEABLE[(i + d) % UNPARSEABLE.length],
        // V1 stored this on every other_degrees entry and rendered it nowhere.
        gpa: `3.${20 + d}`,
      })),
    }, 1)

    // icu_experience -- every bullet array is ['']
    add('icu_experience', {
      positions: Array.from({ length: POSITION_DISTRIBUTION[i] }, (_, p) => {
        const n = i * 3 + p
        return {
          position: 'Registered Nurse',
          unit_type: n % 12 === 0 ? '' : 'Medical ICU',
          hospital: n % 15 === 0 ? '' : `Hospital ${i + 1}-${p + 1}`,
          location: 'Newark, NJ',
          acuity: 'High',
          start_date: n % 9 === 0 ? '' : n % 7 === 0 ? UNPARSEABLE[n % UNPARSEABLE.length] : '2021-03',
          end_date: p === 0 ? '' : n % 8 === 0 ? UNPARSEABLE[(n + 1) % UNPARSEABLE.length] : '2023-06',
          is_current: p === 0,
          devices: n % 11 === 0 ? [] : ['Ventilator', 'CRRT'],
          patient_population: n % 13 === 0 ? [] : ['Septic shock'],
          // The V1 defect, in every single position.
          bullet_points: [''],
        }
      }),
    }, 2)

    add('certifications', {
      certifications: Array.from({ length: Math.max(0, CERTIFICATIONS[i] - 1) }, (_, c) => ['CCRN', 'ACLS', 'BLS', 'PALS', 'TNCC', 'CMC'][c % 6]),
      custom_certifications: CERTIFICATIONS[i] > 0 ? [`Custom cert ${i + 1}`] : [],
    }, 3)

    add('shadowing', {
      experiences: Array.from({ length: SHADOWING[i] }, (_, e) => ({
        crna_name: `CRNA ${i + 1}-${e + 1}`,
        hours: e === 0 ? '40+' : '20',
        setting: 'Operating room',
        description: `Observed practice during shadowing ${e + 1}.`,
      })),
    }, 4)

    add('leadership', {
      roles: Array.from({ length: LEADERSHIP[i] }, (_, r) => `Charge nurse, unit ${r + 1}, 2021-2023`),
    }, 5)

    add('research', {
      projects: Array.from({ length: RESEARCH[i] }, (_, r) => `CLABSI reduction project ${r + 1}`),
    }, 6)
  }

  return { resumes, sections: [...sections, ...(overrides.extraSections ?? [])] }
}

/** A second row of the same legacy type, for the duplicate-review case. */
export function duplicateSectionRow(resumeId: string, sectionType: string): V1SectionRow {
  return {
    id: uuid(9999),
    resume_id: resumeId,
    section_type: sectionType,
    section_data: { nursing_degree: { degree: 'MSN', field: 'Nursing', university: 'A Second Row' }, other_degrees: [] },
    order_index: 9,
  }
}
