# MediaClaw Agent Repository Rules

- Keep browser page parsers, cookies, platform credentials, activation codes, and private backend secrets out of this public repository.
- Treat the browser extension as the final authorization and capture executor. Agent-side code may request capabilities but must not bypass extension policy.
- Keep host manifests thin. Shared business behavior belongs in the common Skill, contracts, adapter, or Broker rather than duplicated Codex/Claude/WorkBuddy implementations.
- Preserve independent device identity and revocation for every installed Agent host.
- Run `npm run check`, the Codex plugin validator, and the available host manifest validators before release.
- Do not claim a host is supported until installation, pairing, reconnection, free-tier behavior, and at least one real capture have passed on that host.
