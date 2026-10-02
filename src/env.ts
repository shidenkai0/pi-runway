// Commands inherit Pi's environment, which usually carries provider API keys.
// Anything that looks like a credential is removed before a command runs; a
// command that genuinely needs one can be escalated, or the user can list the
// variable in `keepEnv`.

const SECRET_NAME = /(^|_)(API_?KEY|APIKEY|KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASS|PASSPHRASE|PWD_HASH|CREDENTIALS?|PAT|PRIVATE_KEY|ACCESS_KEY|SESSION_KEY|SESSION|AUTH|COOKIE|DSN|JWT|WEBHOOK_URL)($|_)/i
const SECRET_EXACT = new Set(['PGPASSWORD', 'MYSQL_PWD', 'SSHPASS', 'DATABASE_URL', 'REDIS_URL', 'MONGODB_URI', 'MONGO_URL', 'POSTGRES_URL', 'AMQP_URL', 'SENTRY_DSN', 'NPM_CONFIG__AUTH', 'OP_SESSION', 'VAULT_TOKEN', 'KUBECONFIG'])
const SECRET_PREFIX = /^(AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_|OPENAI_|ANTHROPIC_|OPENROUTER_|TYPESAFE_|GEMINI_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_|COHERE_|HF_|HUGGING|REPLICATE_|TOGETHER_|FIREWORKS_|CEREBRAS_|ZAI_|MOONSHOT_|KIMI_|STRIPE_|TWILIO_|SLACK_|DISCORD_|TELEGRAM_|GH_|GITHUB_TOKEN|GITLAB_|CLOUDFLARE_|VERCEL_|NETLIFY_|FLY_|HEROKU_|SUPABASE_|FIREBASE_|DOPPLER_)/i
// Names that match the patterns above but are not credentials.
const NOT_SECRET = new Set(['SSH_AUTH_SOCK', 'GPG_TTY', 'KEYTIMEOUT', 'TERM_SESSION_ID', 'XDG_SESSION_ID', 'XDG_SESSION_TYPE', 'XDG_SESSION_CLASS', 'XDG_SESSION_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS', 'SECURITYSESSIONID', 'XPC_SERVICE_NAME', 'PASSWORD_STORE_DIR', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'GOOGLE_CLOUD_PROJECT', 'GH_HOST', 'GH_PAGER', 'PI_SESSION_ID', 'PI_SESSION_FILE'])
// Values that are credentials regardless of the variable name.
const SECRET_VALUE = /^(sk-[A-Za-z0-9_-]{16,}|sk-or-|sk-ant-|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[baprs]-|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i

export function isSecretEnvName(name: string): boolean {
  if (NOT_SECRET.has(name.toUpperCase())) return false
  if (SECRET_EXACT.has(name.toUpperCase())) return true
  return SECRET_NAME.test(name) || SECRET_PREFIX.test(name)
}

export function isSecretEnvValue(value: string): boolean {
  return SECRET_VALUE.test(value) || URL_WITH_CREDENTIALS.test(value)
}

export interface ScrubResult {
  env: NodeJS.ProcessEnv
  removed: string[]
}

export function scrubEnv(env: NodeJS.ProcessEnv, keep: readonly string[] = []): ScrubResult {
  const keepSet = new Set(keep.map(name => name.toUpperCase()))
  const out: NodeJS.ProcessEnv = {}
  const removed: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!keepSet.has(name.toUpperCase()) && (isSecretEnvName(name) || isSecretEnvValue(value))) {
      removed.push(name)
      continue
    }
    out[name] = value
  }
  return { env: out, removed: removed.sort() }
}
