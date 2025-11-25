# Agent Workflow Overview

## Pipeline
- **PRE_CHECK** (finalModel): Decides whether to run the agent.
- **CLARIFY** (baseModel): Terminology/version verification. Must use tools; outputs `<CLARIFY_OUTPUT>`.
- **PLAN** (baseModel): Trusts CLARIFY, defines unknowns and research objectives (Stage 1 prerequisites → Stage 2 main). No tool calls expected. Outputs `<PLAN_OUTPUT>`.
- **RESEARCH** (baseModel, loop): Executes Stage 1 subqueries then Stage 2 main queries, must call tools (googleSearch/urlContext). Outputs `<RESEARCH_NOTES>`.
- **CONTROL** (baseModel, loop): Chooses `research` or `final` via `control_step`. Outputs `<CONTROL_DECISION>`.
- **FINAL** (finalModel): User-facing answer only, no agent tags.

## Models
- `baseModel`: PRE_CHECK, CLARIFY, PLAN, RESEARCH, CONTROL.
- `finalModel`: FINAL (user-facing).
- Thinking config is shared (`baseThinking`).

## Tooling
- googleSearch, urlContext available to CLARIFY/PLAN/RESEARCH (PLAN only if it chooses).
- RESEARCH must call tools; CONTROL uses only `control_step`.

## Tag & Thought Discipline
- Internal steps wrap responses in required tags; no text outside.
- Thoughts start with `Thinking Process:<AGENT>` for CLARIFY/PLAN/RESEARCH/CONTROL.
- FINAL: no `<AGENT>`; user-facing only.

## Grounding Summary Toggle
- Env: `AGENT_INCLUDE_GROUNDING` (default: `false`).
  - `true`: Inject source/query summaries into prompts.
  - `false`: Omit summaries to save tokens (notes from prior steps are still passed).

## Date Handling
- Current date passed each step: local time `YYYY-MM-DD`. Use for freshness judgments.

## Research Stages
- Stage 1 (subqueries): Prerequisite context (versions, capabilities, compatibility).
- Stage 2 (main): User-answer queries after prerequisites are known.
- If plan has subqueries: run ≥1 subquery and ≥1 main. If none: run ≥1 main.

## Source Reliability
- For API/library/spec/math/science: fetch source pages with urlContext and extract from content (not snippets).
- Prior step findings are respected; override only with immediate tool-based verification.

## Files
- `backend/agent/runner.js`: Orchestrates steps, chat creation, and prompt assembly.
- `backend/agent/prompts.js`: Common policies, critical rules, and turn-specific prompt snippets.

## Minimal Setup
- Ensure `.env` (or environment) provides model name for `baseModel` (e.g., `AGENT_BASE_MODEL=gemini-2.5-flash`).
- Optional: `AGENT_INCLUDE_GROUNDING=true` to inject summaries of gathered sources/queries (default false).
- Optional: `AGENT_DEBUG=true` to emit debug logs from the runner.
