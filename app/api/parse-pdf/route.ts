import { NextResponse } from 'next/server'
import { PdfReader } from 'pdfreader'

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File
    
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    
    return new Promise<NextResponse>((resolve) => {
      let text = ''
      
      new PdfReader().parseBuffer(buffer, (err: any, item: any) => {
        if (err) {
          console.error('PDF parse error:', err)
          resolve(NextResponse.json({ error: err.message }, { status: 500 }))
        } else if (!item) {
          resolve(NextResponse.json({ text }))
        } else if (item.text) {
          text += item.text + ' '
        }
      })
    })
  } catch (error: any) {
    console.error('PDF extraction error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
