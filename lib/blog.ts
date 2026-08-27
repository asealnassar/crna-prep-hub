import fs from 'fs'
import path from 'path'
import { marked } from 'marked'

const BLOG_DIR = path.join(process.cwd(), 'content', 'blog')

/**
 * Everything from this heading onward is editorial planning notes for the
 * author — internal-link tables, cluster notes, CTA suggestions. It must never
 * reach a reader.
 */
const EDITORIAL_MARKER = '## Internal Links to Add'

export interface BlogPost {
  slug: string
  title: string
  seoTitle: string
  metaDescription: string
  primaryKeyword: string
  secondaryKeywords: string[]
  searchIntent: string
  isPillar: boolean
  order: number
  html: string
  readingMinutes: number
  excerpt: string
}

interface Frontmatter {
  [key: string]: string | string[]
}

/**
 * Minimal YAML-subset parser for our own frontmatter. Splits on the first
 * colon only, so values containing colons (SEO titles routinely do) survive.
 */
function parseFrontmatter(raw: string): { data: Frontmatter; body: string } {
  if (!raw.startsWith('---')) return { data: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: raw }

  const block = raw.slice(4, end)
  const body = raw.slice(end + 4).replace(/^\s*\n/, '')
  const data: Frontmatter = {}
  let currentListKey: string | null = null

  for (const line of block.split('\n')) {
    if (!line.trim()) continue

    const listItem = line.match(/^\s+-\s+(.*)$/)
    if (listItem && currentListKey) {
      ;(data[currentListKey] as string[]).push(listItem[1].trim())
      continue
    }

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()

    if (value === '') {
      data[key] = []
      currentListKey = key
    } else {
      data[key] = value
      currentListKey = null
    }
  }

  return { data, body }
}

function str(v: string | string[] | undefined, fallback = ''): string {
  if (Array.isArray(v)) return v[0] ?? fallback
  return v ?? fallback
}

function list(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v
  return v ? [v] : []
}

function toPost(filename: string): BlogPost | null {
  const raw = fs.readFileSync(path.join(BLOG_DIR, filename), 'utf-8')
  const { data, body } = parseFrontmatter(raw)

  const slugPath = str(data.slug)
  if (!slugPath) return null
  const slug = slugPath.replace(/^\/blog\//, '').replace(/\/$/, '')

  // Drop the editorial notes, then the trailing --- rule that preceded them.
  const cut = body.indexOf(EDITORIAL_MARKER)
  let article = cut === -1 ? body : body.slice(0, cut)
  article = article.replace(/\n---\s*$/, '').trim()

  const h1 = article.match(/^#\s+(.+)$/m)
  const title = h1 ? h1[1].trim() : str(data.seo_title, slug)

  // First real paragraph after the H1, for the index card.
  const afterH1 = h1 ? article.slice(article.indexOf(h1[0]) + h1[0].length) : article
  const firstPara = afterH1
    .split('\n\n')
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('-'))
  const excerpt = (firstPara || str(data.meta_description))
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  const words = article.split(/\s+/).filter(Boolean).length

  return {
    slug,
    title,
    seoTitle: str(data.seo_title, title),
    metaDescription: str(data.meta_description),
    primaryKeyword: str(data.primary_keyword),
    secondaryKeywords: list(data.secondary_keywords),
    searchIntent: str(data.search_intent),
    isPillar: str(data.role).toUpperCase() === 'PILLAR',
    order: parseInt(str(data.article, '999'), 10),
    html: marked.parse(article, { gfm: true, breaks: false }) as string,
    readingMinutes: Math.max(1, Math.round(words / 225)),
    excerpt,
  }
}

export function getAllPosts(): BlogPost[] {
  if (!fs.existsSync(BLOG_DIR)) return []
  return fs
    .readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('00-'))
    .map(toPost)
    .filter((p): p is BlogPost => p !== null)
    .sort((a, b) => a.order - b.order)
}

export function getPost(slug: string): BlogPost | null {
  return getAllPosts().find((p) => p.slug === slug) ?? null
}

/** Question headings become FAQPage entries for rich results and AI overviews. */
export function extractFaqs(html: string): { question: string; answer: string }[] {
  const faqSection = html.split(/<h2[^>]*>Frequently asked questions<\/h2>/i)[1]
  if (!faqSection) return []

  const faqs: { question: string; answer: string }[] = []
  const pattern = /<p><strong>([\s\S]+?)\?<\/strong>\s*(?:<br\s*\/?>)?\s*([\s\S]+?)<\/p>/gi
  let m: RegExpExecArray | null
  while ((m = pattern.exec(faqSection)) !== null) {
    faqs.push({
      question: m[1].replace(/<[^>]+>/g, '').trim() + '?',
      answer: m[2].replace(/<[^>]+>/g, '').trim(),
    })
  }
  return faqs
}
