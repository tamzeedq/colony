// Input validation for everything that ends up in a Docker object name, a container argv or a
// git ref. The Docker driver never builds shell strings from these values (it passes argv
// arrays and positional parameters), but validating up front gives clear errors and a second
// line of defence. Pure functions so they can be unit tested without Docker.

export class InfraValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InfraValidationError'
  }
}

/** Project slug: lowercase, digits and dashes, starts with a letter or digit. Used in Docker
 *  names (colony-proj-<slug>, colony-git-<slug>) and as a DNS-ish label. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

/** Agent id: Docker container-name safe. */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Environment variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function assertSlug(slug: string): string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new InfraValidationError(`invalid project slug: ${JSON.stringify(slug)}`)
  }
  return slug
}

export function assertAgentId(agentId: string): string {
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    throw new InfraValidationError(`invalid agent id: ${JSON.stringify(agentId)}`)
  }
  return agentId
}

export function assertEnv(env: Record<string, string>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new InfraValidationError(`invalid env var name: ${JSON.stringify(k)}`)
    if (typeof v !== 'string') throw new InfraValidationError(`env var ${k} must be a string`)
    if (v.includes('\0')) throw new InfraValidationError(`env var ${k} contains NUL`)
    out.push(`${k}=${v}`)
  }
  return out
}

/** Mirrors `git check-ref-format --branch` (plus stricter Colony rules: no leading dash, only
 *  [A-Za-z0-9._/+-], max 200 chars). The driver additionally runs the real
 *  `git check-ref-format` inside the git container before using a name. Names are only ever
 *  passed as argv / positional parameters, so the whitelist is defence in depth. */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > 200) return false
  if (!/^[A-Za-z0-9._/+-]+$/.test(name)) return false   // no spaces, control or shell metachars
  if (/[~^:?*[\\]/.test(name)) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false
  if (name.endsWith('.') || name === '@') return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  for (const part of name.split('/')) {
    if (part.startsWith('.') || part.endsWith('.lock')) return false
  }
  return true
}

export function assertBranch(name: string): string {
  if (!isValidBranchName(name)) throw new InfraValidationError(`invalid branch name: ${JSON.stringify(name)}`)
  return name
}

/** Remote URL accepted for `git clone --bare`. Only network transports; no file://, no ext::,
 *  no option-looking strings. */
export function assertRepoUrl(url: string): string {
  const ok =
    typeof url === 'string' &&
    url.length <= 2000 &&
    !url.startsWith('-') &&
    /^[\x21-\x7e]+$/.test(url) &&
    (/^(https?|git|ssh):\/\/[^/\s]+/i.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url))
  if (!ok) throw new InfraValidationError(`invalid repo url: ${JSON.stringify(url)}`)
  return url
}

/** Merge commit message: any text, but bounded and NUL-free (it is passed as one argv item). */
export function assertMessage(message: string): string {
  if (typeof message !== 'string' || message.trim() === '') throw new InfraValidationError('merge message is required')
  if (message.length > 10_000 || message.includes('\0')) throw new InfraValidationError('invalid merge message')
  return message
}

/** GitHub `owner/name`. Owner: alphanumerics and single dashes; name: [A-Za-z0-9._-]. */
export const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/

export function isGithubRepo(repo: string): boolean {
  return typeof repo === 'string' && GITHUB_REPO_RE.test(repo) && !/\/\.\.?$/.test(repo) && !repo.endsWith('.git')
}

/** Push target for pushToRemote: https only, no credentials, no option-looking strings. */
export function assertPushUrl(url: string): string {
  let ok = typeof url === 'string' && url.length <= 500 && /^https:\/\/[!-~]+$/.test(url)
  if (ok) {
    try {
      const u = new URL(url)
      ok = u.protocol === 'https:' && !u.username && !u.password
    } catch { ok = false }
  }
  if (!ok) throw new InfraValidationError(`invalid push url: ${JSON.stringify(url)}`)
  return url
}

/** Local ref for pushToRemote: refs/heads/<valid branch>. */
export function assertLocalRef(ref: string): string {
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || !isValidBranchName(ref.slice(11))) {
    throw new InfraValidationError(`invalid ref: ${JSON.stringify(ref)}`)
  }
  return ref
}

export const names = {
  network: (slug: string) => `colony-proj-${slug}`,
  gitVolume: (slug: string) => `colony-git-${slug}`,
  gitContainer: (slug: string) => `colony-git-${slug}`,
  agentContainer: (agentId: string) => `colony-agent-${agentId}`,
  agentVolume: (agentId: string) => `colony-ws-${agentId}`,
}

/** refs/colony/checkpoints/<agentId>/<ts> or refs/colony/backup/<agentId>/<ts>, and their prefixes. */
export const COLONY_REF_RE = /^refs\/colony\/(checkpoints|backup)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/(\d{10,16})?$/
export const SHA_RE = /^[0-9a-f]{40}$/

export function assertColonyRef(ref: string, { prefix = false } = {}): string {
  if (typeof ref !== 'string' || !COLONY_REF_RE.test(ref) || (prefix ? !ref.endsWith('/') : ref.endsWith('/'))) {
    throw new InfraValidationError(`invalid colony ref: ${String(ref).slice(0, 120)}`)
  }
  return ref
}
export function assertSha(sha: string): string {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new InfraValidationError('invalid commit sha')
  return sha
}
