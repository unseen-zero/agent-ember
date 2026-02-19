import path from 'path'

export type SkillSourceFormat = 'openclaw' | 'plain'

type NormalizeSkillInput = {
  name?: unknown
  description?: unknown
  filename?: unknown
  content?: unknown
  sourceUrl?: unknown
}

export type NormalizedSkill = {
  name: string
  description: string
  filename: string
  content: string
  sourceUrl?: string
  sourceFormat: SkillSourceFormat
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill'
}

function sanitizeFilename(input: string): string {
  const base = path.basename(input.trim())
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '-')
  if (!safe) return 'skill.md'
  return safe.toLowerCase().endsWith('.md') ? safe : `${safe}.md`
}

function parseFrontmatterBlock(content: string): { frontmatter: Record<string, string>; body: string } | null {
  const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const rawFrontmatter = match[1]
  const body = match[2] || ''

  const frontmatter: Record<string, string> = {}
  for (const rawLine of rawFrontmatter.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = stripQuotes(line.slice(idx + 1).trim())
    if (key) frontmatter[key] = value
  }

  return { frontmatter, body }
}

function deriveNameFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Unnamed Skill'
}

function deriveFilenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const basename = path.basename(u.pathname)
    if (!basename) return null
    if (basename.toUpperCase() === 'SKILL.MD') {
      const parent = path.basename(path.dirname(u.pathname))
      if (parent) return `${slugify(parent)}.md`
    }
    return sanitizeFilename(basename)
  } catch {
    return null
  }
}

export function normalizeSkillPayload(input: NormalizeSkillInput): NormalizedSkill {
  const rawContent = typeof input.content === 'string' ? input.content : ''
  const parsed = parseFrontmatterBlock(rawContent)

  const frontmatterName = asTrimmedString(parsed?.frontmatter?.name)
  const frontmatterDescription = asTrimmedString(parsed?.frontmatter?.description)

  const sourceUrl = asTrimmedString(input.sourceUrl) || undefined

  const initialFilename = asTrimmedString(input.filename)
    || (sourceUrl ? deriveFilenameFromUrl(sourceUrl) : null)
    || (frontmatterName ? `${slugify(frontmatterName)}.md` : null)
    || 'skill.md'
  const filename = sanitizeFilename(initialFilename)

  const name = asTrimmedString(input.name)
    || frontmatterName
    || deriveNameFromFilename(filename)

  const description = asTrimmedString(input.description)
    || frontmatterDescription
    || ''

  // For OpenClaw SKILL.md, keep only body instructions when frontmatter exists.
  const normalizedContent = parsed ? parsed.body.trimStart() : rawContent

  const sourceFormat: SkillSourceFormat = parsed && (frontmatterName !== null || frontmatterDescription !== null || parsed.frontmatter.metadata)
    ? 'openclaw'
    : 'plain'

  return {
    name,
    description,
    filename,
    content: normalizedContent,
    sourceUrl,
    sourceFormat,
  }
}
