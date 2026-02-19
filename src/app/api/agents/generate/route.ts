import { NextResponse } from 'next/server'
import { z } from 'zod'
import { buildLLM } from '@/lib/server/build-llm'

const agentSchema = z.object({
  name: z.string().describe('Short name for the agent'),
  description: z.string().describe('One sentence describing what it does'),
  systemPrompt: z.string().describe('Full system prompt — thorough and specific, at least 3-4 paragraphs'),
  isOrchestrator: z.boolean().describe('True only if it needs to coordinate multiple sub-agents'),
})

const GENERATE_PROMPT = `You are a agent generator. The user will describe an AI agent they want to create. Generate a complete agent definition.

Set isOrchestrator to true ONLY if the user describes something that needs to coordinate multiple sub-agents.
Make the systemPrompt detailed and actionable — at least 3-4 paragraphs. Include specific instructions about how the agent should behave, what it should focus on, and how it should format its responses.`

export async function POST(req: Request) {
  const { prompt } = await req.json()
  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
  }

  try {
    const { llm, provider } = await buildLLM()
    const structured = provider === 'anthropic'
      ? llm.withStructuredOutput(agentSchema)
      : (llm as any).withStructuredOutput(agentSchema, {
          name: 'agent_definition',
          method: 'functionCalling',
        })
    const result = await structured.invoke([
      { role: 'system' as const, content: GENERATE_PROMPT },
      { role: 'user' as const, content: prompt },
    ], { signal: AbortSignal.timeout(60_000) })

    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Generation failed'
    console.error('[agent-generate] Error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
