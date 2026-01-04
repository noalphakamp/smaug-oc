# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Smaug is a Twitter/X bookmark archiver that fetches bookmarks (and/or likes), expands t.co links, extracts content from linked pages, and uses Claude Code for intelligent categorization and filing to a knowledge library.

## Commands

```bash
# Full workflow (fetch + process with Claude)
npx smaug run

# With token usage tracking
npx smaug run -t

# Fetch only (no processing)
npx smaug fetch 20                    # Fetch 20 bookmarks
npx smaug fetch --all                 # Fetch ALL bookmarks (paginated)
npx smaug fetch --all --max-pages 5   # Limit pagination to 5 pages
npx smaug fetch --source likes        # Fetch from likes
npx smaug fetch --source both         # Fetch from both
npx smaug fetch --media               # Include media attachments (experimental)
npx smaug fetch --force               # Re-fetch already archived

# Status/info
npx smaug status
npx smaug process                     # Show pending bookmarks

# Setup
npx smaug setup                       # Interactive wizard
```

## Architecture

### Two-Phase Workflow

1. **Fetch Phase** (`processor.js`): Fetches tweets via `bird` CLI, expands t.co links, extracts GitHub/article content, outputs JSON to `.state/pending-bookmarks.json`

2. **Process Phase** (`job.js` → Claude Code): Invokes Claude Code with `/process-bookmarks` skill to categorize and file bookmarks

### Key Files

- `src/cli.js` - CLI entry point, command parsing
- `src/job.js` - Job runner with lock management, Claude Code invocation, webhook notifications
- `src/processor.js` - Bookmark fetching, link expansion, content extraction
- `src/config.js` - Configuration loading from file/env
- `.claude/commands/process-bookmarks.md` - Claude Code processing instructions

### Data Flow

```
Twitter API (via bird CLI)
    ↓
.state/pending-bookmarks.json (prepared bookmarks with expanded links)
    ↓
Claude Code processes per .claude/commands/process-bookmarks.md
    ↓
bookmarks.md (archive entries)
knowledge/tools/*.md (GitHub repos)
knowledge/articles/*.md (articles)
```

### Categories System

Categories in `smaug.config.json` or defaults in `config.js` define how bookmarks are handled:
- `github` → files to `knowledge/tools/`
- `article` → files to `knowledge/articles/`
- `podcast`, `youtube`, `video` → flagged for transcription
- `tweet` → captured in bookmarks.md only

## Claude Code Processing

When processing 3+ bookmarks, the `/process-bookmarks` skill spawns parallel Haiku subagents for cost efficiency (~50% savings). Each subagent handles a batch of ~5 bookmarks independently.

Key processing rules from `.claude/commands/process-bookmarks.md`:
- Bookmarks are added to date sections in `bookmarks.md` (newest first)
- GitHub repos get filed to `knowledge/tools/` with frontmatter
- Articles get filed to `knowledge/articles/` with frontmatter
- Quote tweets include quoted content in the entry
- Replies include parent context

## Configuration

Primary config: `smaug.config.json`

Key options:
- `source`: "bookmarks", "likes", or "both"
- `claudeModel`: "sonnet", "haiku", or "opus"
- `autoInvokeClaude`: whether to run Claude after fetch
- `categories`: custom category definitions
- `folders`: map folder IDs to tag names (e.g., `{"1234567890": "ai-tools"}`)

Environment variables override config (e.g., `AUTH_TOKEN`, `CT0`, `CLAUDE_MODEL`).

### Bookmark Folders

Configure folders to preserve Twitter bookmark folder organization as tags:
```json
{
  "folders": {
    "1234567890": "ai-tools",
    "0987654321": "research"
  }
}
```
Get folder IDs from URLs like `https://x.com/i/bookmarks/1234567890`.

## External Dependencies

- `bird` CLI (https://github.com/steipete/bird) - Twitter API wrapper, requires v0.5.0+ for bookmarks
  - For `--all` pagination: build from git main branch (not npm v0.5.1)
- `dayjs` - date handling
