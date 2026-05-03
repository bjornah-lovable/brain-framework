/**
 * Best-effort regex-based secret scan for capture bodies + frontmatter.
 *
 * This is defense-in-depth, not a guarantee. The capture rubric
 * already says "summarise; don't paste raw secrets." This catches the
 * common accidents: pasting a stack trace with an `Authorization`
 * header, dropping a token from a debug session, including a JWT
 * still attached to an example, and so on.
 *
 * On match, the caller routes the capture to .brain/needs-review/
 * instead of the live captures plane. The matched text is **never**
 * echoed back to the agent — only the pattern names. Surfacing the
 * match would defeat the purpose.
 */

interface PatternDef {
  name: string;
  re: RegExp;
}

const PATTERNS: PatternDef[] = [
  { name: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws_temp_access_key", re: /\bASIA[0-9A-Z]{16}\b/ },
  { name: "github_pat_classic", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "github_pat_fine_grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "github_oauth", re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: "stripe_live_secret", re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: "stripe_test_secret", re: /\bsk_test_[A-Za-z0-9]{20,}\b/ },
  { name: "slack_bot_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "openai_api_key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "anthropic_api_key", re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/ },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    name: "pem_private_key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED |)PRIVATE KEY-----/,
  },
  {
    name: "authorization_header",
    re: /\bAuthorization:\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]{16,}/i,
  },
  {
    name: "cookie_header_with_value",
    re: /\bCookie:\s*\S+=[A-Za-z0-9._\-+/=]{16,}/i,
  },
];

export interface SecretScanResult {
  /** True if any pattern matched. */
  hit: boolean;
  /** Names of patterns that matched (no actual secret content). */
  patterns: string[];
}

export function scanForSecrets(text: string): SecretScanResult {
  const hits = new Set<string>();
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) hits.add(name);
  }
  return { hit: hits.size > 0, patterns: [...hits].sort() };
}
