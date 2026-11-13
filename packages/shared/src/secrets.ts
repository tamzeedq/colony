// Secret-shaped strings and files (feedback item 6). One pattern set, used by the control
// plane (redaction on ingest, the request_merge / publish guards) and the Merge Review UI
// (red flags). docker/git-hooks/pre-commit mirrors these patterns in POSIX sh.

export interface SecretPattern {
  id: string
  label: string
  /** Global regex; the whole match is the secret unless `group` names the value group. */
  re: RegExp
  group?: number
}

/** Values that are obviously placeholders, not secrets (README / example snippets). */
const PLACEHOLDER = /^(?:your|xxx|<|\{|\$|\[|example|changeme|change-me|placeholder|replace|dummy|todo|redacted|\*\*\*|\.\.\.|…)|(?:your[-_]|_here|-here|example|placeholder|xxxx|\.\.\.|…)/i

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'private_key', label: 'private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'anthropic', label: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { id: 'openai', label: 'API key (sk-…)', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'github', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g },
  { id: 'supabase', label: 'Supabase key', re: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g },
  { id: 'aws', label: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'slack', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    id: 'assignment', label: 'KEY= / SECRET= / TOKEN= assignment',
    // Upper-case env-style names only (FOO_API_KEY=…, SECRET: …), so code like `const token = x` is left alone.
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD))\b["']?\s*[=:]\s*["']?([^\s"'`,;)]{8,})/g, group: 2,
  },
]

/** Is this matched value a real-looking secret (not a placeholder or a variable reference)? */
function realValue(p: SecretPattern, value: string): boolean {
  if (p.id !== 'assignment') return true
  if (PLACEHOLDER.test(value)) return false
  if (/^(?:process\.env|os\.environ|import\.meta\.env|env\.|Deno\.env|getenv|true|false|null|undefined)/.test(value)) return false
  return true
}

export interface SecretMatch { id: string; label: string; index: number; value: string }

/** Every secret-shaped value in `text` (with its offset). */
export function findSecrets(text: string): SecretMatch[] {
  const out: SecretMatch[] = []
  if (!text) return out
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0
    for (const m of text.matchAll(p.re)) {
      const value = p.group ? m[p.group] : m[0]
      if (!value || !realValue(p, value)) continue
      const index = (m.index ?? 0) + (p.group ? m[0].lastIndexOf(value) : 0)
      out.push({ id: p.id, label: p.label, index, value })
    }
  }
  return out
}

/** Labels of the secret kinds found in one line (empty when clean). */
export function secretKinds(line: string): string[] {
  return [...new Set(findSecrets(line).map((m) => m.label))]
}

/** Why a file path must never be committed ('block'), deserves a look ('warn'), or undefined. */
export function secretFileRisk(path: string): { level: 'block' | 'warn'; reason: string } | undefined {
  const base = (path.split('/').pop() ?? path).toLowerCase()
  if (/^\.env(?:\..+)?$/.test(base) && !/^\.env\.(?:example|sample|template|dist)$/.test(base)) {
    return { level: 'block', reason: 'env file (use .env.local, which is git-ignored, and commit only .env.example)' }
  }
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(base)) return { level: 'block', reason: 'key or certificate file' }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base)) return { level: 'block', reason: 'SSH private key' }
  if (/secret|credential/.test(base)) return { level: 'warn', reason: 'file name suggests secrets' }
  return undefined
}

export interface DiffSecretFinding {
  path: string
  /** Line number in the new file, when the finding is a line. */
  line?: number
  kind: string
  /** The line with the secret values masked (safe to show). */
  preview?: string
}

/** Replace every secret-shaped value in `text` with a mask. */
export function maskSecrets(text: string, mask = '[redacted]'): string {
  const hits = findSecrets(text).sort((a, b) => b.index - a.index)
  let out = text
  let lastStart = Infinity
  for (const h of hits) {
    if (h.index + h.value.length > lastStart) continue // overlapping match already masked
    out = out.slice(0, h.index) + mask + out.slice(h.index + h.value.length)
    lastStart = h.index
  }
  return out
}

/** Scan a unified diff (`git diff main...branch`): files that must not be added, and added
 *  lines with secret-shaped strings. Deleted files are fine (removing a secret is good). */
export function scanDiffForSecrets(diff: string): { files: DiffSecretFinding[]; lines: DiffSecretFinding[] } {
  const files: DiffSecretFinding[] = []
  const lines: DiffSecretFinding[] = []
  let path = ''
  let deleted = false
  let newNo = 0
  let inHunk = false
  const flushFile = () => {
    if (!path || deleted) return
    const risk = secretFileRisk(path)
    if (risk?.level === 'block') files.push({ path, kind: risk.reason })
  }
  for (const raw of (diff ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushFile()
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      path = m ? m[2] : raw.slice(11)
      deleted = false
      inHunk = false
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('deleted file mode')) deleted = true
      if (raw.startsWith('+++ ')) { const p = raw.slice(4).replace(/^b\//, ''); if (p !== '/dev/null') path = p }
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      newNo = m ? Number(m[1]) : 0
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      const text = raw.slice(1)
      const kinds = secretKinds(text)
      if (kinds.length && secretFileRisk(path)?.level !== 'block') {
        lines.push({ path, line: newNo, kind: kinds.join(', '), preview: maskSecrets(text).trim().slice(0, 160) })
      }
      newNo++
    } else if (raw.startsWith(' ')) newNo++
  }
  flushFile()
  return { files, lines }
}
