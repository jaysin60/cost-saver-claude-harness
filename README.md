# cost-saver-claude-harness

A Claude Code plugin, **agent-flow**, with two halves that work together:

1. **A live dashboard pane** that shows what your session is doing while it
   runs: the main session, every subagent it starts, every tool call, which
   model each one runs on, where the tokens are going, and a session log you
   can replay afterwards.
2. **Five model-tiered agents** that keep the expensive models for judgment
   and send the bulk, mechanical work to the cheapest one.

The idea: run your normal session on a mid-tier model, keep most work in that
one loop, and delegate only where a separate context actually pays off.
Cheap agents do bounded jobs such as searching or running tests, and the top
models are called rarely, for decisions. The dashboard lets you see whether
that is happening.

## The agents

| Agent | Model | What it is for |
|---|---|---|
| `agent-flow:scout` | Haiku 5.5 | Read-only code and file search. Returns `path:line` findings instead of pouring raw search output into the main context. |
| `agent-flow:runner` | Haiku 5.5 | Runs tests, builds and linters. Returns PASS/FAIL and the first failures, never the whole log. Never edits files. |
| `agent-flow:advisor` | Opus 5.5 | A second opinion on a consequential decision (a design choice, a risky refactor, a bug that survived two fixes). Returns a short, fixed-format verdict and says when to escalate. |
| `agent-flow:lead-advisor` | Fable 5.2 | Final ruling, only on escalation or on decisions that are expensive to reverse. |
| `agent-flow:architect` | Fable 5.2 | The start of substantial work: a spec with checkable acceptance criteria, a solution design, and an orchestration plan saying which agent or session builds each piece, on which model. |

Why the split saves tokens: at Anthropic's API list prices when this was
written, Haiku 5.5 input costs about $0.10 per million tokens against Sonnet
5.5's $2, Opus 5.5's $4 and Fable 5.2's $8. A search or a test run that
returns thousands of lines costs a twentieth as much read by Haiku, and the
main session only reads the short answer. A subagent starts with a fresh
context and doesn't share the main session's prompt cache, though, so each
agent's description tells Claude when **not** to use it: small lookups stay
in the main loop.

The approach follows Anthropic's article
[*Building agents: when to fold subagents into your main agent loop*](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop):
keep work in one loop by default, and split it off by context, not by org
chart. Every agent replies in a short fixed format, so its result is compact
and predictable.

Use **Sonnet 5.5** as the session's main model: pick it in the model picker,
or run `/model` in a terminal session.

## The dashboard

Open it with `/agent-flow`; it also opens by itself when a session starts.

- **Number tiles:** tool calls, running now, agents active, errors, tokens
  and the session's cost (the figure `/cost` shows).
- **Progress:** the session's task list as a bar with the current step, and
  a tokens-by-model bar (for example "Sonnet 72% · Haiku 20% · Opus 8%").
- **Main session card:** model, Working/Idle, context-window fill, turns,
  calls, the current task list and what it is doing now.
- **Tools and subagents:** a TOOLS card that groups the main session's own
  calls by kind (click to expand the list), then a card per subagent with
  its model, colored while it works and grey once done. Older finished
  agents are grouped by type. Arrows show each input going out
  (`─task─▶`) and each result coming back (`◀report─`).
- **Session log:** a compact table of every call, subagent start and report,
  newest first.
- **Replay:** once a session is idle, **▶ Replay** plays the session back
  quickly, skipping idle gaps, at 2×, 5× or 20×. **▶ Previous session**
  replays the last session you ran.
- **Tree:** a plain text view, which is also what a terminal pane shows.

It runs inside Claude Code as a function-hook plugin and sends nothing
anywhere: everything it shows comes from the session's own events.

## Install

At the prompt of a terminal session:

```
/plugin install agent-flow --marketplace jaysin60/cost-saver-claude-harness
```

Answer `y` to add the marketplace, then choose a scope (the user scope makes
it available in every session).

From a shell:

```bash
claude plugin install agent-flow --marketplace jaysin60/cost-saver-claude-harness
```

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`jaysin60/cost-saver-claude-harness`, then **Add plugin**.

This repository is private, so it installs only for people who can read it
on GitHub and whose machine already holds a git credential for github.com
(an SSH key, or `gh auth login` followed by `gh auth setup-git`). The
install never prompts for one.

## Requirements

A Claude Code build that supports function-hook plugins: built and tested on
2.1.321. The desktop app draws the dashboard with pictures for the bars, and
a terminal pane draws the text tree. The agents need access to the models
they name; change any model in its `agents/<name>.md` file (`model:`).

## Customizing

- **Models and effort:** the `model:`, `effort:` and `maxTurns:` lines at the
  top of each file in `agents/`.
- **When an agent is used:** its `description:` line. Claude reads it when
  deciding whether to delegate.
- **Colors:** the palette `C` near the top of `hooks/register.tsx`.
- **What counts as bookkeeping:** `isBookkeeping()` in `hooks/register.tsx`
  decides which calls (plan updates, tool search) are left out of the map
  and log.

## Layout

```
.claude-plugin/plugin.json       the plugin manifest
.claude-plugin/marketplace.json  makes this repo installable as a marketplace
hooks/hooks.json                 names the hooks module
hooks/register.tsx               the dashboard: event hooks and the pane
types/index.d.ts                 the dashboard's state contract
agents/*.md                      the five agents
```

## License

MIT. See [LICENSE](LICENSE).
