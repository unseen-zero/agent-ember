import { NextResponse } from 'next/server'
import { buildLLM } from '@/lib/server/build-llm'

/** Returns which provider/model the generate endpoints will use */
export async function GET() {
  try {
    const { provider, model } = await buildLLM()
    return NextResponse.json({ provider, model })
  } catch (err: any) {
    return NextResponse.json({ provider: 'none', model: '', error: err.message })
  }
}
