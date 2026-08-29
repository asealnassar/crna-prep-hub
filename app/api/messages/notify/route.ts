import { NextRequest } from 'next/server'
import { handleMessageNotification } from '@/lib/messageNotify'

export async function POST(request: NextRequest) {
  return handleMessageNotification(request)
}
