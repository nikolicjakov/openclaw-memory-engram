# memory-engram

OpenClaw plugin for [Engram](https://github.com/Gentleman-Programming/engram) — persistent
structured memory for AI agents with SQLite + FTS5 full-text search.

> **Which Engram?** This plugin integrates with
> [Gentleman-Programming/engram](https://github.com/Gentleman-Programming/engram) — the Go-based,
> agent-agnostic memory system with SQLite + FTS5, MCP server, HTTP API, CLI, and TUI.
> It is **not** related to other projects that share the "engram" name.

## The Problem

AI coding agents forget everything between sessions. Every time a conversation ends or the
context window compacts, all the decisions, discoveries, configurations, and lessons learned
vanish. The next session starts from zero — the agent doesn't know what was tried before,
what failed, what conventions were agreed on, or what the project even looks like.

This creates real problems when you work with agents daily:

- **Repeated mistakes** — the agent makes the same wrong assumption it made last week because
  it has no memory of the correction
- **Lost context** — you explained your infrastructure, credentials layout, or deployment
  process once, but after compaction the agent asks again
- **No continuity** — session summaries and handoff notes disappear, so picking up where you
  left off requires re-explaining everything
- **Wasted tokens** — you spend half your context window re-establishing what the agent
  should already know

## How This Plugin Solves It

This plugin connects OpenClaw to [Engram](https://github.com/Gentleman-Programming/engram),
giving every agent a persistent, searchable long-term memory that survives across sessions,
compactions, and restarts.

**Automatic recall** — before each agent turn, the plugin searches Engram for memories
relevant to the current message and injects them into the prompt. The agent sees past
decisions and context without you having to ask it to "check memory first".

**Structured storage** — agents save observations with types (decision, bugfix, config,
procedure, etc.), projects, and topic keys. This isn't a raw conversation dump — it's
organized knowledge that stays useful over time.

**Topic-based deduplication** — when an agent saves a memory with the same `topic_key` as
an existing one, it updates the existing memory instead of creating a duplicate. Evolving
knowledge stays consolidated in one place.

**Works alongside OpenClaw's built-in memory** — this plugin uses the `engram_*` tool
namespace, so it runs in parallel with `memory-core` (Markdown-based memory) without
conflicts. You get both systems: structured Engram observations for decisions and context,
and Markdown files for curated long-term notes.

## Features

- **11 agent tools** (`engram_*` namespace) — full memory lifecycle from search to session management
- **Automatic memory recall (RAG)** — searches Engram on every incoming message and injects relevant memories into agent context before the LLM sees the prompt
- **Smart query extraction** — strips channel metadata (Mattermost/Telegram/Discord framing, timestamps) and stop words from prompts to produce clean FTS5 search keywords
- **Progressive FTS5 fallback** — when the full keyword query returns no results, progressively drops terms until a match is found
- **Session deduplication** — memories already injected in the current session are not repeated, saving context tokens on long conversations
- **Dynamic snippet sizing** — auto-recall distributes a fixed character budget across results (more detail for fewer results, less for many)
- **Full-text search** via BM25 ranking with project/type/scope filters
- **Topic-based deduplication** — same `topic_key` updates existing memory instead of creating duplicates
- **Progressive disclosure** — search → get → timeline (token-efficient)
- **Session lifecycle** — start, context loading, save, end with summary
- **Auto-session creation** — `engram_save` auto-creates sessions (no FOREIGN KEY errors)
- **Prompt injection protection** — recalled memories are sanitized and escaped before context injection
- **Graceful degradation** — all tools return clean error messages if Engram is unreachable
- **Coexists with memory-core** — no tool name conflicts, both systems work in parallel
- **CLI tools** — `openclaw engram search/get/recent/context/status/migrate/suggest-key/export/import`
- **Compaction awareness** — logs compaction events for diagnostics

## How Auto-Recall Works

When `autoRecall` is enabled (default), the plugin hooks into `before_prompt_build` and
`before_agent_start` to intercept every incoming message before the agent processes it:

```
User message → Strip channel metadata → Extract keywords → Search Engram
                                                              ↓
                                              Score & filter results
                                                              ↓
                                              Deduplicate (skip already-seen)
                                                              ↓
                                              Budget snippet size per result
                                                              ↓
                                              Inject as prependContext with IDs
                                                              ↓
                                              Agent sees memories + prompt
```

1. **Channel metadata stripping** — removes system framing like `System: [2026-03-28 16:39 UTC] Mattermost DM from @user:` that would pollute FTS5 search
2. **Stop word removal** — filters out common words ("what", "how", "please", "my", etc.) that have no value in a full-text search
3. **Progressive fallback** — FTS5 uses AND logic by default, so `kubernetes cluster configuration` fails if "configuration" isn't indexed. The plugin progressively drops trailing keywords (`kubernetes cluster` → `kubernetes`) until results appear
4. **Relevance filtering** — results are BM25-scored and filtered by `recallMinScore` threshold
5. **Session deduplication** — memories already injected earlier in the same session are skipped, avoiding repeated context on long conversations
6. **Dynamic snippet sizing** — a total character budget (1500 chars) is divided across results: 1 result gets the full budget, 5 results get 300 chars each
7. **Observation IDs included** — each injected snippet includes `[#ID]` so agents can call `engram_get` for full content
8. **Injection protection** — each memory is checked against prompt injection patterns and HTML-escaped before being added to context

## Prerequisites

### 1. Install and run Engram

Engram is a standalone Go binary. See [Engram installation docs](https://github.com/Gentleman-Programming/engram/blob/main/docs/INSTALLATION.md) for all options.

```bash
# macOS / Linux (Homebrew)
brew install gentleman-programming/tap/engram

# From source
git clone https://github.com/Gentleman-Programming/engram.git
cd engram && go install ./cmd/engram

# Or download a binary from GitHub Releases:
# https://github.com/Gentleman-Programming/engram/releases
```

Start the HTTP server (default port 7437):

```bash
engram serve
```

Verify it's running:

```bash
curl http://127.0.0.1:7437/health
```

For production, run as a systemd service:

```ini
[Unit]
Description=Engram Memory Server
After=network.target

[Service]
ExecStart=/usr/local/bin/engram serve
Restart=always
Environment=ENGRAM_DATA_DIR=/path/to/.engram

[Install]
WantedBy=default.target
```

### 2. OpenClaw

- OpenClaw >= 2026.3.13
- Node.js >= 22

## Installation

Clone the plugin to a local directory:

```bash
git clone https://github.com/nikolicjakov/memory-engram.git
cd openclaw-memory-engram && npm install
```

## Configuration

Add to your `openclaw.json`. The `paths` array must point to the absolute path where you
cloned the plugin — this is how OpenClaw discovers and loads it:

```jsonc
{
  "plugins": {
    "allow": ["memory-engram"],
    "load": {
      "paths": ["/path/to/openclaw-memory-engram"]
    },
    "entries": {
      "memory-engram": {
        "enabled": true,
        "config": {
          "url": "http://127.0.0.1:7437",
          "project": "general",
          "maxResults": 10,
          "timeoutMs": 5000,
          "autoRecall": true,
          "autoCapture": false,
          "recallLimit": 5,
          "recallMinScore": 0.3
        }
      }
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### Tool visibility

If your agents use `tools.profile: "coding"` or `tools.profile: "messaging"`, plugin tools may not
be visible. Set `tools.profile: "full"` globally or add `"memory-engram"` to `tools.allow`:

```jsonc
{
  "tools": {
    "profile": "full"
  }
}
```

## Coexistence with memory-core

This plugin runs **alongside** `memory-core`, not as a replacement. Do NOT set
`plugins.slots.memory` to `memory-engram` unless you want to disable Markdown memory entirely.

| System | Searches | Tool names | Purpose |
|--------|----------|------------|---------|
| `memory-core` | Markdown files (`MEMORY.md`, `memory/*.md`) | `memory_search`, `memory_get` | Daily logs, curated long-term notes |
| `memory-engram` | Engram database (SQLite + FTS5) | `engram_*` (11 tools) | Structured observations, decisions, session history |

## Agent Tools

All tools use the `engram_*` namespace to avoid conflicts with core tools.

### Core Memory Operations

| Tool | Description |
|------|-------------|
| `engram_search` | Full-text search with BM25 ranking, project/type/scope filters. Strategy: search with project first, broaden without project if no hits. |
| `engram_get` | Retrieve full observation by ID (no truncation). Use after `engram_search` for complete details. |
| `engram_save` | Store observation with auto-session creation and `topic_key` deduplication. Content format: **What**/**Why**/**Where**/**Learned**. |
| `engram_update` | Partial update of existing observation (only provided fields change). |
| `engram_delete` | Soft-delete (default, recoverable) or hard-delete an observation. |

### Session Lifecycle

| Tool | Description |
|------|-------------|
| `engram_session_start` | Register a new session. Session ID format: `<agent>-YYYY-MM-DD-NNN`. |
| `engram_session_end` | End session with summary. Summary format: `Goal: X. Discoveries: Y. Accomplished: Z. Next: W.` |
| `engram_context` | Load project context (recent sessions, observations, prompts) for session bootstrap. |

### Progressive Disclosure

| Tool | Description |
|------|-------------|
| `engram_timeline` | Chronological context around an observation (what happened before/after in the same session). |
| `engram_recent` | Browse recent observations, optionally filtered by project and scope. |
| `engram_stats` | Engram health check, project discovery, and total counts. |

### Observation Types

Tools accept a `type` parameter with these values:

`decision` `bugfix` `discovery` `config` `pattern` `preference` `session_summary` `warning` `procedure` `general`

## Hooks

The plugin registers the following lifecycle hooks:

| Hook | When | What it does |
|------|------|-------------|
| `before_prompt_build` | Before each agent turn | Auto-recall: searches Engram with extracted keywords, injects relevant memories as `prependContext` |
| `before_agent_start` | Before each agent turn (legacy) | Same auto-recall handler, registered for backward compatibility with older OpenClaw versions |
| `before_compaction` | Before context compaction | Logs compaction events (message count, token count, agent ID) |
| `agent_end` | After agent completes (if `autoCapture` enabled) | Experimental: auto-captures user messages as session summaries |

## CLI Commands

```bash
openclaw engram search "docker configuration"
openclaw engram search "auth setup" --project homelab --type config
openclaw engram get 42
openclaw engram recent --project general --limit 20
openclaw engram context general
openclaw engram status
openclaw engram migrate old-project new-project
openclaw engram suggest-key decision "Switched to JWT auth"
openclaw engram export --pretty > engram-backup.json
openclaw engram import engram-backup.json
```

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | `http://127.0.0.1:7437` | Engram HTTP API base URL |
| `project` | string | `general` | Default project (fallback only — agents specify per-call) |
| `maxResults` | number | `10` | Maximum search results |
| `timeoutMs` | number | `5000` | HTTP request timeout in milliseconds |
| `autoRecall` | boolean | `true` | Automatically inject relevant memories before each agent turn |
| `autoCapture` | boolean | `false` | Auto-capture agent outputs as memories (experimental) |
| `recallLimit` | number | `5` | Maximum memories injected during auto-recall |
| `recallMinScore` | number | `0.3` | Minimum normalized BM25 relevance score for auto-recall (0.0-1.0) |

## Project Structure

```
openclaw-memory-engram/
├── index.ts                  # Plugin entry point — tools, hooks, CLI registration
├── src/
│   └── engram-client.ts      # HTTP client for Engram API + config parsing
├── openclaw.plugin.json      # OpenClaw plugin manifest
├── package.json
├── tsconfig.json
└── README.md
```

## Engram Environment Variables

Engram itself (not the plugin) is configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ENGRAM_DATA_DIR` | Data directory containing the SQLite database | `~/.engram` (Windows: `%USERPROFILE%\.engram`) |
| `ENGRAM_PORT` | HTTP server port | `7437` |

The data directory contains:

```
~/.engram/
├── engram.db          # SQLite database (WAL mode)
├── engram.db-shm      # Shared memory file
└── engram.db-wal      # Write-ahead log
```

To change the database location, set `ENGRAM_DATA_DIR` before starting the server:

```bash
export ENGRAM_DATA_DIR="/opt/engram-data"
engram serve
```

Or in a systemd service:

```ini
Environment=ENGRAM_DATA_DIR=/opt/engram-data
```

The directory is created automatically if it doesn't exist. If you change the data directory on
an existing installation, move the `engram.db*` files to the new location first to preserve
your memories.

## Links

- [Engram](https://github.com/Gentleman-Programming/engram) — the memory system this plugin integrates with
- [OpenClaw Plugin Docs](https://docs.openclaw.ai/plugins/building-plugins) — building OpenClaw plugins
- [OpenClaw Hooks](https://docs.openclaw.ai/automation/hooks) — hook system documentation

## License

MIT
