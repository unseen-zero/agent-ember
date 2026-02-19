import { NextResponse } from 'next/server'
import { z } from 'zod'
import { buildLLM } from '@/lib/server/build-llm'

const scheduleSchema = z.object({
  name: z.string().describe('Short descriptive name for the schedule'),
  taskPrompt: z.string().describe('The prompt/instructions the agent should execute when the schedule fires'),
  scheduleType: z.enum(['cron', 'interval', 'once']).describe('Type of schedule'),
  cron: z.string().optional().describe('Cron expression if scheduleType is cron, e.g. "0 9 * * 1" for every Monday at 9am'),
  intervalMs: z.number().optional().describe('Interval in milliseconds if scheduleType is interval'),
})

const taskSchema = z.object({
  title: z.string().describe('Short descriptive title for the task'),
  description: z.string().describe('Detailed description of what needs to be done'),
})

const skillSchema = z.object({
  name: z.string().describe('Short name for the skill'),
  description: z.string().describe('One sentence describing what this skill does'),
  content: z.string().describe('Full markdown content of the skill — detailed instructions, at least 3-4 paragraphs'),
})

const providerSchema = z.object({
  name: z.string().describe('Display name for the provider, e.g. "Together AI", "Groq", "z.ai"'),
  baseUrl: z.string().describe('The OpenAI-compatible API base URL, e.g. "https://api.together.xyz/v1" or "https://api.groq.com/openai/v1"'),
  models: z.string().describe('Comma-separated list of available model IDs, e.g. "llama-3-70b,mixtral-8x7b"'),
  requiresApiKey: z.boolean().describe('Whether this provider requires an API key'),
})

const SCHEMAS: Record<string, { schema: z.ZodObject<any>; prompt: string }> = {
  schedule: {
    schema: scheduleSchema,
    prompt: `You are a schedule generator for SwarmClaw, an AI agent orchestration platform. The user will describe what they want scheduled. Generate a complete schedule definition.

Choose the appropriate scheduleType:
- "cron" for recurring schedules (provide a cron expression)
- "interval" for periodic execution (provide intervalMs in milliseconds)
- "once" for one-time execution

Make the taskPrompt detailed and specific — it should contain everything the agent needs to know to complete the task.`,
  },
  task: {
    schema: taskSchema,
    prompt: `You are a task generator for SwarmClaw, an AI agent orchestration platform. The user will describe a task they want to create. Generate a clear task definition.

Make the description thorough and actionable — include specific goals, acceptance criteria, and any relevant context. The description should give an AI agent enough information to complete the task autonomously.`,
  },
  skill: {
    schema: skillSchema,
    prompt: `You are a skill generator for SwarmClaw, an AI agent orchestration platform. Skills are reusable markdown instruction sets that get injected into agent system prompts.

The user will describe what skill they want. Generate a comprehensive skill definition with detailed markdown content. The content should be:
- Written as instructions/guidelines for an AI agent
- Thorough and specific (at least 3-4 paragraphs)
- Structured with markdown headings, lists, and examples
- Focused on actionable guidance the agent can follow`,
  },
  provider: {
    schema: providerSchema,
    prompt: `You are a provider configuration generator for SwarmClaw, an AI agent orchestration platform. The user will name an LLM provider they want to add.

Generate the correct OpenAI-compatible API configuration. You should know the base URLs and model names for popular providers:
- Together AI: https://api.together.xyz/v1
- Groq: https://api.groq.com/openai/v1
- Fireworks: https://api.fireworks.ai/inference/v1
- Perplexity: https://api.perplexity.ai
- Mistral: https://api.mistral.ai/v1
- DeepSeek: https://api.deepseek.com/v1
- OpenRouter: https://openrouter.ai/api/v1
- xAI/Grok: https://api.x.ai/v1
- z.ai: https://api.z.ai/v1

List the most popular/recommended models for the provider as comma-separated values. Most providers require an API key.
If you don't know the exact URL, make your best guess based on common patterns (provider domain + /v1).`,
  },
}

export async function POST(req: Request) {
  const { type, prompt } = await req.json()
  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
  }
  const config = SCHEMAS[type]
  if (!config) {
    return NextResponse.json({ error: `Invalid type: ${type}. Must be one of: ${Object.keys(SCHEMAS).join(', ')}` }, { status: 400 })
  }

  try {
    const { llm, provider } = await buildLLM()
    const structured = provider === 'anthropic'
      ? llm.withStructuredOutput(config.schema)
      : (llm as any).withStructuredOutput(config.schema, {
          name: `${type}_definition`,
          method: 'functionCalling',
        })
    const result = await structured.invoke([
      { role: 'system' as const, content: config.prompt },
      { role: 'user' as const, content: prompt },
    ], { signal: AbortSignal.timeout(60_000) })
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Generation failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
