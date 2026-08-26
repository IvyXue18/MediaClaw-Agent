# MediaClaw Agent Public Repository Rules

## Source Ownership

- This repository is the only development source for MediaClaw Agent host code: MCP Server, Broker, launchers, upgrades, Codex/WorkBuddy manifests, Skills, methods, tests, and release workflows.
- The sibling `mediaclaw` product repository remains the normal conversation entry point and owns the browser extension, sidebar, Studio, local browser execution, data pool, and backend.
- A task started from the product repository may edit this repository directly when Agent behavior is in scope. Do not mirror Agent source back into the product repository.
- Cross-repository compatibility is declared by `mediaclaw/integrations/agent/agent-lock.json` and verified read-only from the product repository.

- Keep public documentation written for end users: what MediaClaw Agent does, how to install it, how to connect it, and where to get help.
- Do not publish product roadmaps, internal development checklists, test progress, unresolved partner or host discussions, private service details, or MediaClaw implementation notes.
- Do not place browser cookies, platform credentials, activation codes, private keys, private backend details, or real user data in this repository.
- Do not claim a capability or host is generally available unless the corresponding public release supports it.
- Preserve MediaClaw's user authorization, paid-action confirmation, privacy, and safety boundaries.
- Keep user-facing changes consistent across README, installation help, manifests, release notes, and security guidance.
