# Colony: notes for Claude

- Monorepo with npm workspaces (`apps/*`, `packages/*`). Node 22, TypeScript, ESM.
- The plan of record is `docs/execution-plan.md`. Check the current phase before starting work.
- UI: `apps/ui`, built from the Claude Design handoff. Its tokens (`apps/ui/tokens/`), `src/design/status.ts` and `src/types/colony.ts` are the design source of truth. Use the design's names (e.g. `ActivityEvent` kinds) end to end.
- Agents run `claude -p --input-format stream-json --output-format stream-json` in `colony-agent` containers, authenticated with the user's subscription via `CLAUDE_CODE_OAUTH_TOKEN`.
- Hard rules: never bind-mount host paths or the Docker socket into agent containers. Never let anything merge to `main` without a recorded human approval. Never commit secrets (`.env` is ignored).
- Host is Windows with Docker Desktop. Keep shell scripts LF (see `.gitattributes`).
