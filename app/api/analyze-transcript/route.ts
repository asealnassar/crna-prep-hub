import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const { text } = await request.json()
    
    if (!text) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 })
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: `Analyze this transcript and extract ALL courses with their details.

Transcript:
${text}

TRANSFER COURSE IDENTIFICATION:
Look for indicators like:
- "Transfer" or "TR" or "T" in the course listing
- Courses from other institutions listed on this transcript
- Courses marked as "accepted transfer credit"
- Any indication the course was taken at a different school
Note: Transfer courses should be marked with "isTransfer": true

CATEGORIZATION RULES (courses can have MULTIPLE categories):
1. "science" category: Biology, Chemistry, Physics, Anatomy, Physiology, Microbiology, Pathophysiology, Pharmacology, Organic Chemistry, Biochemistry, Genetics, Immunology, any science-based medical course
2. "nursing" category: ANY nursing course including Nursing Theory, Medical-Surgical Nursing, Pediatric Nursing, Psychiatric Nursing, Community Health Nursing, Nursing Leadership, etc.
3. "general" category: Non-science, non-nursing courses (English, Math, Psychology, Sociology, etc.)

IMPORTANT: 
- Pathophysiology = ["science", "nursing"]
- Pharmacology = ["science", "nursing"]  
- Medical-Surgical Nursing = ["science", "nursing"]
- Anatomy for Nurses = ["science", "nursing"]
- General Chemistry = ["science"]
- Nursing Leadership = ["nursing"]
- English Composition = ["general"]

Extract year/term if visible (e.g., "Fall 2023", "2022-2023", "Spring 2024")

Return ONLY a JSON array:
[
  {
    "name": "Pathophysiology",
    "grade": "A",
    "credits": 3,
    "categories": ["science", "nursing"],
    "year": "2023",
    "term": "Fall",
    "isTransfer": false
  },
  {
    "name": "English Composition",
    "grade": "B+",
    "credits": 3,
    "categories": ["general"],
    "year": "2022",
    "term": "Fall",
    "isTransfer": true
  }
]

Use standard letter grades: A, A-, B+, B, B-, C+, C, C-, D+, D, F`
        }],
        temperature: 0.3
      })
    })

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error: any) {
    console.error('OpenAI error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
