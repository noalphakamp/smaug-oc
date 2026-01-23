# Smaug OpenCode Integration Plan

## Overview

Add OpenCode as an alternative AI provider alongside Claude Code for Smaug's bookmark processing functionality. Users can choose between `claude-code` (default, existing) or `opencode` via configuration.

## User Requirements

1. **Dual support**: Option to use Claude Code or OpenCode
2. **Model**: `openrouter/minimax/minimax-m2.1`
3. **Parallel processing**: Keep current batch + merge approach, use OpenCode's native subagent system
4. **Integration method**: CLI (`opencode run`)

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `plan.md` | Create | This file |
| `src/config.js` | Modify | Add OpenCode config options and helper functions |
| `src/job.js` | Modify | Add `invokeOpenCode()` function, refactor for dual provider support |
| `smaug.config.example.json` | Modify | Add OpenCode config example |
| `smaug.config.json` | Modify | Add OpenCode config options (user's actual config) |
| `.opencode/commands/process-bookmarks.md` | Create | OpenCode command file |
| `.claude/commands/process-bookmarks.md` | Rename | Rename to `.claude/commands/process-bookmarks-claude.md` |
| `README.md` | Modify | Add OpenCode setup and configuration section |

---

## Phase 1: Config Structure

### New Config Options

Add to `smaug.config.json`:

```json
{
  "aiProvider": "claude-code",
  "opencode": {
    "model": "openrouter/minimax/minimax-m2.1",
    "agent": "general",
    "subtask": true,
    "allowedTools": "Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite"
  },
  "claudeCode": {
    "model": "sonnet",
    "allowedTools": "Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite"
  }
}
```

### Config Helper Functions (src/config.js)

```javascript
export function getAIProvider(config) {
  return config.aiProvider || 'claude-code';
}

export function getOpenCodeConfig(config) {
  return {
    model: config.opencode?.model || 'openrouter/minimax/minimax-m2.1',
    agent: config.opencode?.agent || 'general',
    subtask: config.opencode?.subtask ?? true,
    allowedTools: config.opencode?.allowedTools || 'Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite'
  };
}

export function getClaudeCodeConfig(config) {
  return {
    model: config.claudeCode?.model || config.claudeModel || 'sonnet',
    allowedTools: config.claudeCode?.allowedTools || config.allowedTools || 'Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite'
  };
}
```

### Backward Compatibility

Existing configs continue to work:

```json
{
  "claudeModel": "sonnet"
}
```

Maps to `claudeCode.model` internally.

---

## Phase 2: OpenCode Command File

### File: `.opencode/commands/process-bookmarks.md`

```markdown
---
description: Process Twitter bookmarks into markdown archive with AI analysis
agent: general
model: openrouter/minimax/minimax-m2.1
subtask: true
---

# /process-bookmarks

Process prepared Twitter bookmarks into a markdown archive with rich analysis and optional filing to a knowledge library.

## Before You Start

### Multi-Step Parallel Protocol (CRITICAL)

**Create todo list IMMEDIATELY after reading bookmark count.** This ensures final steps never get skipped.

**Check parallelThreshold from config** (default: 8). Use parallel processing only when bookmark count >= threshold. For smaller batches, sequential processing is faster due to subagent overhead.

```bash
node -e "console.log(require('./smaug.config.json').parallelThreshold ?? 8)"
```

**For bookmarks below threshold (sequential):**
```javascript
TodoWrite({ todos: [
  {content: "Read pending bookmarks", status: "pending", activeForm: "Reading pending bookmarks"},
  {content: "Process bookmark 1", status: "pending", activeForm: "Processing bookmark 1"},
  {content: "Process bookmark 2", status: "pending", activeForm: "Processing bookmark 2"},
  {content: "Clean up pending file", status: "pending", activeForm: "Cleaning up pending file"},
  {content: "Commit and push changes", status: "pending", activeForm: "Committing changes"},
  {content: "Return summary", status: "pending", activeForm: "Returning summary"}
]})
```

**For bookmarks at or above threshold (use OpenCode subagents with batch files):**
```javascript
TodoWrite({ todos: [
  {content: "Read pending bookmarks", status: "pending", activeForm: "Reading pending bookmarks"},
  {content: "Spawn subagents to write batch files", status: "pending", activeForm: "Spawning subagents"},
  {content: "Wait for all subagents to complete", status: "pending", activeForm: "Waiting for subagents"},
  {content: "Merge batch files into bookmarks.md", status: "pending", activeForm: "Merging batch files"},
  {content: "Clean up batch and pending files", status: "pending", activeForm: "Cleaning up files"},
  {content: "Commit and push changes", status: "pending", activeForm: "Committing changes"},
  {content: "Return summary", status: "pending", activeForm: "Returning summary"}
]})
```

**Execution rules:**
- Mark each step `in_progress` before starting
- Mark `completed` immediately after finishing (no batching)
- Only ONE task `in_progress` at a time
- Never skip final steps (commit, summary)

**CRITICAL for parallel processing:** Use OpenCode's subagent system to spawn multiple agents in parallel. Each writes to a batch file:

```javascript
// Use Task tool with OpenCode's agent system
// Verified syntax from OpenCode testing
Task({ subagent_type: "general", description: "Process batch 0", prompt: "Write to .state/batch-0.md: {json for bookmarks 0-4}" })
Task({ subagent_type: "general", description: "Process batch 1", prompt: "Write to .state/batch-1.md: {json for bookmarks 5-9}" })
Task({ subagent_type: "general", description: "Process batch 2", prompt: "Write to .state/batch-2.md: {json for bookmarks 10-14}" })
// ... all batches in the SAME message
```

After ALL subagents complete, merge batch files into bookmarks.md in chronological order.

**DO NOT:**
- Have subagents write directly to bookmarks.md (race conditions!)
- Process bookmarks above threshold sequentially (too slow)
- Skip the merge step

### Setup

**Get today's date (friendly format):**
```bash
date +"%A, %B %-d, %Y"
```

Use this format for date section headers (e.g., "Thursday, January 2, 2026").

**Load paths and categories from config:**
```bash
node -e "const c=require('./smaug.config.json'); console.log(JSON.stringify({archiveFile:c.archiveFile, pendingFile:c.pendingFile, stateFile:c.stateFile, categories:c.categories}, null, 2))"
```

This gives you:
- `archiveFile`: Where to write the bookmark archive
- `pendingFile`: Where pending bookmarks are stored
- `stateFile`: Where processing state is tracked
- `categories`: Custom category definitions

**IMPORTANT:** Use these paths throughout. The `~` will be the user's home directory.
If no custom categories, use the defaults from `src/config.js`.

## Input

Prepared bookmarks are in the `pendingFile` path from config (typically `./.state/pending-bookmarks.json` or a custom path).

Each bookmark includes:
- `id`, `author`, `authorName`, `text`, `tweetUrl`, `date`
- `tags[]` - folder tags from bookmark folders (e.g., `["ai-tools"]`)
- `links[]` - each with `original`, `expanded`, `type`, and `content`
  - `type`: "github", "article", "video", "tweet", "media", "image"
  - `content`: extracted text, headline, author (for articles/github)
- `isReply`, `replyContext` - parent tweet info if this is a reply
- `isQuote`, `quoteContext` - quoted tweet info if this is a quote tweet

## Categories System

Categories define how different bookmark types are handled. Each category has:
- `match`: URL patterns or keywords to identify this type
- `action`: What to do with matching bookmarks
  - `file`: Create a separate markdown file in the folder
  - `capture`: Just add to bookmarks.md
  - `transcribe`: Flag for future transcription, add to bookmarks.md with transcript note
- `folder`: Where to save files (for `file` action)
- `template`: Which template to use (`tool`, `article`, `podcast`, `video`)

**Default categories:**
| Category | Match Patterns | Action | Folder |
|----------|---------------|--------|--------|
| github | github.com | file | ./knowledge/tools |
| article | medium.com, substack.com, dev.to, blog | file | ./knowledge/articles |
| podcast | podcasts.apple.com, spotify.com/episode, overcast.fm | transcribe | ./knowledge/podcasts |
| youtube | youtube.com, youtu.be | transcribe | ./knowledge/videos |
| video | vimeo.com, loom.com | transcribe | ./knowledge/videos |
| tweet | (fallback) | capture | - |

## Workflow

### 1. Read the Prepared Data

Read from the `pendingFile` path specified in config. If the path starts with `~`, expand it to the home directory:
```bash
# Get pendingFile from config and expand ~ (cross-platform)
PENDING_FILE=$(node -e "const p=require('./smaug.config.json').pendingFile; console.log(p.replace(/^~/, process.env.HOME || process.env.USERPROFILE))")
cat "$PENDING_FILE"
```

### 2. Process Bookmarks (Parallel when above threshold)

**IMPORTANT: If bookmark count >= parallelThreshold (default 8), you MUST use parallel processing:**

Use the Task tool to spawn multiple subagents simultaneously via OpenCode's agent system.
Each subagent processes a batch of ~5 bookmarks.
Example: 20 bookmarks → spawn 4 subagents (5 each) in ONE message with multiple Task calls.

This is critical for performance. Do NOT process bookmarks sequentially when above threshold.

For each bookmark (or batch):

#### a. Determine the best title/summary

Don't use generic titles like "Article" or "Tweet". Based on the content:
- GitHub repos: Use the repo name and brief description
- Articles: Use the article headline or key insight
- Videos: Note for transcript, use tweet context
- Quote tweets: Capture the key insight being highlighted
- Reply threads: Include parent context in the summary
- Plain tweets: Use the key point being made

#### b. Categorize using the categories config

Match each bookmark's links against category patterns (check `match` arrays). Use the first matching category, or fall back to `tweet`.

**For each action type:**
- `file`: Create a separate file in the category's folder using its template
- `capture`: Just add to bookmarks.md (no separate file)
- `transcribe`: Add to bookmarks.md with a "Needs transcript" flag, optionally create placeholder in folder

**Special handling:**
- Quote tweets: Include quoted tweet context in entry
- Reply threads: Include parent context in entry

#### c. Write bookmark entry

Add to the `archiveFile` path from config (expand `~` to home directory):

**CRITICAL ordering rules for bookmarks.md:**

The file must be in **descending chronological order** (newest dates at TOP, oldest at BOTTOM).

1. **Read the existing file structure first** - note all existing date sections and their positions
2. Use each bookmark's `date` field (already formatted as "Weekday, Month Day, Year")
3. **For each bookmark's date:**
   - If that date section already exists: insert the entry immediately AFTER the `# Date` header (above other entries in that section)
   - If no section exists for that date: create a new `# Weekday, Month Day, Year` section at the **correct chronological position** (NOT always at top!)
4. **Chronological positioning for new date sections:**
   - Find where the date belongs chronologically among existing sections
   - Insert BEFORE any older dates, AFTER any newer dates
   - Example: If file has "Jan 3" then "Jan 1", and you need "Jan 2", insert between them
5. Do NOT create duplicate date sections - always search the entire file first
6. Separate date sections with `---`

**Processing order:** Bookmarks in pending-bookmarks.json are sorted oldest-first. Process them in order so that when each is inserted at the top of its date section, the final result has correct ordering within each day.

**Header hierarchy:**
- `# Thursday, January 2, 2026` - Date headers (h1)
- `## @author - title` - Individual bookmark entries (h2)

**Standard entry format:**
```markdown
## @{author} - {descriptive_title}
> {tweet_text}

- **Tweet:** {tweet_url}
- **Link:** {expanded_url}
- **Tags:** [[tag1]] [[tag2]] (if bookmark has tags from folders)
- **Filed:** [{filename}](./knowledge/tools/{slug}.md) (if filed)
- **What:** {1-2 sentence description of what this actually is}
```

**Tags format:** Use wiki-link style `[[TagName]]` for each tag. Only include the **Tags:** line if the bookmark has tags in its `tags` array (from folder configuration). Example: `- **Tags:** [[AI]] [[Coding]]`

**For quote tweets, include the quoted content:**
```markdown
## @{author} - {descriptive_title}
> {tweet_text}
>
> *Quoting @{quoted_author}:* {quoted_text}

- **Tweet:** {tweet_url}
- **Quoted:** {quoted_tweet_url}
- **Tags:** [[tag1]] [[tag2]] (if bookmark has tags)
- **What:** {description}
```

**For replies, include parent context:**
```markdown
## @{author} - {descriptive_title}
> *Replying to @{parent_author}:* {parent_text}
>
> {tweet_text}

- **Tweet:** {tweet_url}
- **Parent:** {parent_tweet_url}
- **Tags:** [[tag1]] [[tag2]] (if bookmark has tags)
- **What:** {description}
```

Separate entries with `---` only between different dates, not between entries on the same day.

### 3. Clean Up Pending File

After successfully processing, remove the processed bookmarks from the pending file (use `pendingFile` path from config, expanding `~`):

```javascript
const pendingPath = config.pendingFile.replace(/^~/, process.env.HOME);
const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
const processedIds = new Set([/* IDs you processed */]);
const remaining = pending.bookmarks.filter(b => !processedIds.has(b.id));
pending.bookmarks = remaining;
pending.count = remaining.length;
fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
```

### 4. Commit and Push Changes

After all bookmarks are processed and filed, commit the changes:

```bash
# Get today's date for commit message
DATE=$(date +"%b %-d")

# Stage all bookmark-related changes (use archiveFile path from config)
git add "$ARCHIVE_FILE"  # The archiveFile path from config
git add knowledge/

# Commit with descriptive message
git commit -m "Process N Twitter bookmarks from $DATE

🤖 Generated with OpenCode (https://opencode.ai)

Co-Authored-By: OpenAI Mini Max"
```

Replace "N" with actual count. If any knowledge files were created, mention them in the commit message body.

### 5. Return Summary

```
Processed N bookmarks:
- @author1: Tool Name → filed to knowledge/tools/tool-name.md
- @author2: Article Title → filed to knowledge/articles/article-slug.md
- @author3: Plain tweet → captured only

Committed and pushed.
```

## Frontmatter Templates

### Tool Entry (`./knowledge/tools/{slug}.md`)

```yaml
---
title: "{tool_name}"
type: tool
date_added: {YYYY-MM-DD}
source: "{github_url}"
tags: [{relevant_tags}, {folder_tags}]
via: "Twitter bookmark from @{author}"
---

{Description of what the tool does, key features, why it was bookmarked}

## Key Features

- Feature 1
- Feature 2

## Links

- [GitHub]({github_url})
- [Original Tweet]({tweet_url})
```

### Article Entry (`./knowledge/articles/{slug}.md`)

```yaml
---
title: "{article_title}"
type: article
date_added: {YYYY-MM-DD}
source: "{article_url}"
author: "{article_author}"
tags: [{relevant_tags}, {folder_tags}]
via: "Twitter bookmark from @{author}"
---

{Summary of the article's key points and why it was bookmarked}

## Key Takeaways

- Point 1
- Point 2

## Links

- [Article]({article_url})
- [Original Tweet]({tweet_url})
```

### Podcast Entry (`./knowledge/podcasts/{slug}.md`)

```yaml
---
title: "{episode_title}"
type: podcast
date_added: {YYYY-MM-DD}
source: "{podcast_url}"
show: "{show_name}"
tags: [{relevant_tags}, {folder_tags}]
via: "Twitter bookmark from @{author}"
status: needs_transcript
---

{Brief description from tweet context}

## Episode Info

- **Show:** {show_name}
- **Episode:** {episode_title}
- **Why bookmarked:** {context from tweet}

## Transcript

*Pending transcription*

## Links

- [Episode]({podcast_url})
- [Original Tweet]({tweet_url})
```

### Video Entry (`./knowledge/videos/{slug}.md`)

```yaml
---
title: "{video_title}"
type: video
date_added: {YYYY-MM-DD}
source: "{video_url}"
channel: "{channel_name}"
tags: [{relevant_tags}, {folder_tags}]
via: "Twitter bookmark from @{author}"
status: needs_transcript
---

{Brief description from tweet context}

## Video Info

- **Channel:** {channel_name}
- **Title:** {video_title}
- **Why bookmarked:** {context from tweet}

## Transcript

*Pending transcription*

## Links

- [Video]({video_url})
- [Original Tweet]({tweet_url})
```

## Parallel Processing (REQUIRED when above threshold)

**CRITICAL: Subagents must NOT write directly to bookmarks.md** - this causes race conditions and scrambled ordering.

### Two-Phase Approach:

**Phase 1: Parallel batch processing (subagents write to temp files)**

Use OpenCode's Task tool to spawn multiple subagents in ONE message. Each writes to a separate temp file:

```
Task 1: subagent_type="general", "Process batch 0" → writes to .state/batch-0.md
Task 2: subagent_type="general", "Process batch 1" → writes to .state/batch-1.md
Task 3: subagent_type="general", "Process batch 2" → writes to .state/batch-2.md
Task 4: subagent_type="general", "Process batch 3" → writes to .state/batch-3.md
```

**Subagent prompt template:**
```
Process these bookmarks and write ONLY the markdown entries (no date headers) to .state/batch-{N}.md

Bookmarks to process (in order - oldest first):
{JSON array of 5-10 bookmarks}

For each bookmark, write an entry in this format:
---
DATE: {bookmark.date}
## @{author} - {title}
> {tweet text}

- **Tweet:** {url}
- **Tags:** [[tag1]] [[tag2]] (if tags exist)
- **What:** {description}

Also create knowledge files (./knowledge/tools/*.md, ./knowledge/articles/*.md) as needed.
DO NOT touch bookmarks.md - only write to .state/batch-{N}.md
```

**Phase 2: Sequential merge (main agent combines batches)**

After ALL subagents complete:
1. Read all .state/batch-*.md files in order (batch-0, batch-1, batch-2...)
2. Parse each entry (separated by `---`) and extract the DATE line
3. Insert each entry into bookmarks.md at the correct chronological position
4. Delete the temp batch files

**Merge logic for bookmarks.md:**
- File is descending order (newest dates at top)
- For each entry from batch files (processed in order):
  - Find or create the date section at correct position
  - Insert entry at TOP of that date section
- Since batches are oldest-first, entries end up in correct order

**DO NOT:**
- Have subagents write directly to bookmarks.md (causes race conditions)
- Process all bookmarks sequentially (too slow)
- Skip the merge step

## Example Output

```
Processed 4 bookmarks:

1. @tom_doerr: Whisper-Flow (Real-time Transcription)
   → Tool: github.com/dimastatz/whisper-flow
   → Filed: knowledge/tools/whisper-flow.md

2. @simonw: Gist Host Fork for Rendering GitHub Gists
   → Article about GitHub Gist rendering
   → Filed: knowledge/articles/gisthost-gist-rendering.md

3. @michael_chomsky: ResponsiveDialog Component Pattern
   → Quote tweet endorsing @jordienr's UI pattern
   → Captured with quoted context

4. @CasJam: OpenCode Video Post-Production
    → Plain tweet (video content)
    → Captured only, flagged for transcript
```

---

## OpenCode Verified API (from testing)

### Task Tool Syntax

The OpenCode Task tool uses object syntax (not function-call style):

```javascript
Task({
  subagent_type: "general",     // Agent name: "general", "build", "plan", "explore"
  description: "Process batch 0",  // Short description for tracking
  prompt: "Write to .state/batch-0.md: {bookmark data}"
})
```

**Verified parameters:**
- `subagent_type`: Agent name (e.g., "general")
- `description`: Human-readable task description
- `prompt`: Task instructions for the subagent

### JSON Output Event Schema

OpenCode `opencode run --format json` outputs one JSON object per line:

```json
{"type":"step_start","part":{"type":"step-start",...}}
{"type":"text","part":{"type":"text","text":"Response..."}}
{"type":"tool_use","part":{"type":"tool","tool":"write|task|todowrite|...","state":{"status":"completed|pending","input":{...}}}}
{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":N,"output":N,"reasoning":N,"cache":{"read":N,"write":N}},"cost":0.00}}
```

**Key event types:**
- `step_start`: New step begins
- `text`: Text response
- `tool_use`: Tool execution (check `part.tool` for tool name, `part.state.status` for status)
- `step_finish`: Step completed (tokens in `part.tokens`, cost in `part.cost`)

### TodoWrite Tool

```javascript
TodoWrite({
  todos: [
    { content: "Task 1", id: "1", priority: "high", status: "pending|completed" },
    { content: "Task 2", id: "2", priority: "high", status: "pending" }
  ]
})
```

---

## Phase 3: Refactored src/job.js

### New Unified Invocation Structure

```javascript
// ============================================================================
// AI Provider Interface
// ============================================================================

async function invokeAIProvider(config, bookmarkCount, options = {}) {
  const provider = getAIProvider(config);

  if (provider === 'opencode') {
    return invokeOpenCode(config, bookmarkCount, options);
  } else {
    return invokeClaudeCode(config, bookmarkCount, options);
  }
}
```

### invokeOpenCode() Function

```javascript
async function invokeOpenCode(config, bookmarkCount, options = {}) {
  const ocConfig = getOpenCodeConfig(config);
  const timeout = config.claudeTimeout || 900000; // 15 minutes default
  const trackTokens = options.trackTokens || false;

  // Find opencode binary
  let opencodePath = 'opencode';
  const possiblePaths = [
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
    path.join(process.env.HOME || '', '.local/bin/opencode'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      opencodePath = p;
      break;
    }
  }
  // Also check via which if we haven't found it
  if (opencodePath === 'opencode') {
    try {
      opencodePath = execSync('which opencode', { encoding: 'utf8' }).trim() || 'opencode';
    } catch {
      // which failed, stick with 'opencode'
    }
  }

  // Dramatic dragon reveal with fire animation
  const showDragonReveal = async (totalBookmarks) => {
    process.stdout.write('\n');
    const fireFramesIntro = ['🔥', '🔥🔥', '🔥🔥🔥', '🔥🔥🔥🔥', '🔥🔥🔥🔥🔥'];
    for (let i = 0; i < 10; i++) {
      const frame = fireFramesIntro[i % fireFramesIntro.length];
      process.stdout.write(`\r  ${frame.padEnd(12)}`);
      await new Promise(r => setTimeout(r, 150));
    }

    process.stdout.write('\r                    \r');
    process.stdout.write(`  Wait... that's not Claude... it's

  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥
       _____ __  __   _   _   _  ____
      / ____|  \/  | / \ | | | |/ ___|
      \___ \| |\/| |/ _ \| | | | |  _
       ___) | |  | / ___ \ |_| | |_| |
      |____/|_|  |_/_/  \_\___/ \____|

  🐉 The dragon stirs... ${totalBookmarks} treasure${totalBookmarks !== 1 ? 's' : ''} to hoard!
`);
  };

  await showDragonReveal(bookmarkCount);

  return new Promise((resolve) => {
    const args = [
      'run',
      '--format', 'json',
      '--model', ocConfig.model,
      '--',
      `Process the ${bookmarkCount} bookmark(s) in ./.state/pending-bookmarks.json following the instructions in ./.opencode/commands/process-bookmarks.md. Read that file first, then process each bookmark.`
    ];

    // Ensure PATH includes common node locations
    const nodePaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      process.env.NVM_BIN,
      path.join(process.env.HOME || '', '.local/bin'),
      path.join(process.env.HOME || '', '.bun/bin'),
    ];
    const enhancedPath = [...nodePaths, process.env.PATH || ''].join(':');

    // Clean environment
    const cleanEnv = { ...process.env };

    const proc = spawn(opencodePath, args, {
      cwd: config.projectRoot || process.cwd(),
      env: {
        ...cleanEnv,
        PATH: enhancedPath,
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastText = '';
    let filesWritten = [];
    let bookmarksProcessed = 0;
    let totalBookmarks = bookmarkCount;

    // Track parallel tasks
    const parallelTasks = new Map();
    let tasksSpawned = 0;
    let tasksCompleted = 0;

    // Token usage tracking (via OpenCode stats after completion)
    const tokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      model: ocConfig.model,
      subagentModel: ocConfig.model
    };

    // Helper to format time elapsed
    const startTime = Date.now();
    const elapsed = () => {
      const ms = Date.now() - startTime;
      const secs = Math.floor(ms / 1000);
      return secs < 60 ? `${secs}s` : `${Math.floor(secs/60)}m ${secs%60}s`;
    };

    // Progress bar helper
    const progressBar = (current, total, width = 20) => {
      const pct = Math.min(current / total, 1);
      const filled = Math.round(pct * width);
      const empty = width - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      return `[${bar}] ${current}/${total}`;
    };

    // Dragon status messages
    const dragonSays = [
      '🐉 *sniff sniff* Fresh bookmarks detected...',
      '🔥 Breathing fire on these tweets...',
      '💎 Adding treasures to the hoard...',
      '🏔️ Guarding the mountain of knowledge...',
      '⚔️ Vanquishing duplicate bookmarks...',
      '🌋 The dragon\'s flames illuminate the data...',
    ];
    let dragonMsgIndex = 0;
    const nextDragonMsg = () => dragonSays[dragonMsgIndex++ % dragonSays.length];

    // Track one-time messages to avoid duplicates
    const shownMessages = new Set();

    // Animated fire spinner
    const fireFrames = [
      '  🔥    ',
      ' 🔥🔥   ',
      '🔥🔥🔥  ',
      ' 🔥🔥🔥 ',
      '  🔥🔥🔥',
      '   🔥🔥 ',
      '    🔥  ',
      '   🔥   ',
      '  🔥🔥  ',
      ' 🔥 🔥  ',
      '🔥  🔥  ',
      '🔥   🔥 ',
      ' 🔥  🔥 ',
      '  🔥 🔥 ',
      '   🔥🔥 ',
    ];
    const spinnerMessages = [
      'Breathing fire on bookmarks',
      'Examining the treasures',
      'Sorting the hoard',
      'Polishing the gold',
      'Counting coins',
      'Guarding the lair',
      'Hunting for gems',
      'Cataloging riches',
    ];
    let fireFrame = 0;
    let spinnerMsgFrame = 0;
    let lastSpinnerLine = '';
    let spinnerActive = true;
    let currentSpinnerMsg = spinnerMessages[0];

    const msgInterval = setInterval(() => {
      if (!spinnerActive) return;
      spinnerMsgFrame = (spinnerMsgFrame + 1) % spinnerMessages.length;
      currentSpinnerMsg = spinnerMessages[spinnerMsgFrame];
    }, 10000);

    const spinnerInterval = setInterval(() => {
      if (!spinnerActive) return;
      fireFrame = (fireFrame + 1) % fireFrames.length;
      const flame = fireFrames[fireFrame];
      const spinnerLine = `\r  ${flame} ${currentSpinnerMsg}... [${elapsed()}]`;
      process.stdout.write(spinnerLine + '          ');
      lastSpinnerLine = spinnerLine;
    }, 150);

    process.stdout.write('\n  ⏳ Dragons are patient hunters... this may take a moment.\n');
    lastSpinnerLine = '  🔥     Processing...';
    process.stdout.write(lastSpinnerLine);

    const printStatus = (msg) => {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      process.stdout.write(msg);
    };

    const stopSpinner = () => {
      spinnerActive = false;
      clearInterval(spinnerInterval);
      clearInterval(msgInterval);
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    };

    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        if (!line.startsWith('{')) continue;

        try {
          const event = JSON.parse(line);

          // OpenCode event format handling (verified from testing)
          // Event types: step_start, step_finish, tool_use, text
          // Tool use events have: part.type === "tool", part.tool, part.state

          if (event.type === 'tool_use' && event.part) {
            const part = event.part;
            if (part.type === 'tool') {
              const toolName = part.tool;
              const input = part.state?.input || {};

              if (toolName === 'Write' && input.filePath) {
                const fileName = input.filePath.split('/').pop();
                const dir = input.filePath.includes('/knowledge/tools/') ? 'tools' :
                           input.filePath.includes('/knowledge/articles/') ? 'articles' : '';
                filesWritten.push(fileName);
                if (dir) {
                  printStatus(`    💎 Hoarded → ${dir}/${fileName}\n`);
                } else if (fileName === 'bookmarks.md') {
                  bookmarksProcessed++;
                  const fireIntensity = '🔥'.repeat(Math.min(Math.ceil(bookmarksProcessed / 2), 5));
                  printStatus(`  ${fireIntensity} ${progressBar(bookmarksProcessed, totalBookmarks)} [${elapsed()}]`);
                } else {
                  printStatus(`    💎 ${fileName}\n`);
                }
              } else if (toolName === 'Edit' && input.filePath) {
                const fileName = input.filePath.split('/').pop();
                if (fileName === 'bookmarks.md') {
                  bookmarksProcessed++;
                  const fireIntensity = '🔥'.repeat(Math.min(Math.ceil(bookmarksProcessed / 2), 5));
                  printStatus(`  ${fireIntensity} ${progressBar(bookmarksProcessed, totalBookmarks)} [${elapsed()}]`);
                } else if (fileName === 'pending-bookmarks.json') {
                  printStatus(`  🐉 *licks claws clean* Tidying the lair...\n`);
                }
              } else if (toolName === 'Read' && input.filePath) {
                const fileName = input.filePath.split('/').pop();
                if (fileName === 'pending-bookmarks.json' && !shownMessages.has('eye')) {
                  shownMessages.add('eye');
                  printStatus(`  👁️  The dragon's eye opens... surveying treasures...\n`);
                } else if (fileName === 'process-bookmarks.md' && !shownMessages.has('scrolls')) {
                  shownMessages.add('scrolls');
                  printStatus(`  📜 Consulting the ancient scrolls...\n`);
                }
              } else if (toolName === 'task') {
                const desc = input.description || `batch ${tasksSpawned + 1}`;
                const taskKey = `task-${desc}`;
                if (!parallelTasks.has(taskKey)) {
                  tasksSpawned++;
                  parallelTasks.set(taskKey, {
                    description: desc,
                    startTime: Date.now(),
                    status: 'running'
                  });
                  printStatus(`  🐲 Summoning dragon minion: ${desc}\n`);
                  if (tasksSpawned > 1) {
                    printStatus(`     🔥 ${tasksSpawned} dragons now circling the hoard\n`);
                  }
                }
              } else if (toolName === 'Bash') {
                const cmd = input.command || '';
                if (cmd.includes('jq') && cmd.includes('bookmarks')) {
                  printStatus(`  ⚡ ${nextDragonMsg()}\n`);
                }
              }
            }
          }

          // Track task completions (Task tool results)
          if (event.type === 'tool_use' && event.part?.tool === 'task' && event.part?.state?.status === 'completed') {
            tasksCompleted++;
            if (tasksSpawned > 0 && tasksCompleted <= tasksSpawned) {
              const pct = Math.round((tasksCompleted / tasksSpawned) * 100);
              const flames = '🔥'.repeat(Math.ceil(pct / 20));
              printStatus(`  🐲 Dragon minion returns! ${flames} (${tasksCompleted}/${tasksSpawned})\n`);
            }
          }

          // Track token usage (OpenCode format in step_finish events)
          if (event.type === 'step_finish' && event.part?.tokens) {
            tokenUsage.input = event.part.tokens.input || 0;
            tokenUsage.output = event.part.tokens.output || 0;
            tokenUsage.reasoning = event.part.tokens.reasoning || 0;
            tokenUsage.cacheRead = event.part.tokens.cache?.read || 0;
            tokenUsage.cacheWrite = event.part.tokens.cache?.write || 0;
          }

          // Show result summary (step_finish with reason: "stop")
          if (event.type === 'step_finish' && event.part?.reason === 'stop') {
            stopSpinner();

            const hoardDescriptions = {
              small: ['A Few Coins', 'Sparse', 'Humble Beginnings', 'First Treasures', 'A Modest Start'],
              medium: ['Glittering', 'Growing Nicely', 'Respectable Pile', 'Gleaming Hoard', 'Handsome Collection'],
              large: ['Overflowing', 'Mountain of Gold', 'Legendary Hoard', 'Dragon\'s Fortune', 'Vast Riches']
            };

            const tier = totalBookmarks > 15 ? 'large' : totalBookmarks > 7 ? 'medium' : 'small';
            const descriptions = hoardDescriptions[tier];
            const hoardStatus = descriptions[Math.floor(Math.random() * descriptions.length)];

            let tokenDisplay = '';
            if (trackTokens && (tokenUsage.input > 0 || tokenUsage.output > 0)) {
              // OpenRouter pricing (Mini Max M2.1)
              const pricing = {
                'openrouter/minimax/minimax-m2.1': { input: 0.10, output: 0.10, cacheRead: 0, cacheWrite: 0 }
              };

              const modelPricing = pricing[ocConfig.model] || { input: 0.10, output: 0.10 };

              const inputCost = (tokenUsage.input / 1_000_000) * modelPricing.input;
              const outputCost = (tokenUsage.output / 1_000_000) * modelPricing.output;
              const cacheReadCost = (tokenUsage.cacheRead / 1_000_000) * (modelPricing.cacheRead || 0);
              const cacheWriteCost = (tokenUsage.cacheWrite / 1_000_000) * (modelPricing.cacheWrite || 0);

              const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

              const formatNum = (n) => n.toLocaleString();
              const formatCost = (c) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;

              tokenDisplay = `
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📊 TOKEN USAGE (${ocConfig.model})
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Input:       ${formatNum(tokenUsage.input).padStart(10)} tokens  ${formatCost(inputCost)}
    Output:      ${formatNum(tokenUsage.output).padStart(10)} tokens  ${formatCost(outputCost)}
  ${tokenUsage.cacheRead > 0 || tokenUsage.cacheWrite > 0 ? `
    Cache Read:  ${formatNum(tokenUsage.cacheRead).padStart(10)} tokens  ${formatCost(cacheReadCost)}
    Cache Write: ${formatNum(tokenUsage.cacheWrite).padStart(10)} tokens  ${formatCost(cacheWriteCost)}
  ` : ''}
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  💰 TOTAL COST: ${formatCost(totalCost)}
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
            }

            process.stdout.write(`

  🔥🔥🔥  THE DRAGON'S HOARD GROWS!  🔥🔥🔥

              🐉
            /|  |\\
           / |💎| \\      Victory!
          /  |__|  \\
         /  /    \\  \\
        /__/  💰  \\__\\

  ⏱️  Quest Duration:  ${elapsed()}
  📦  Bookmarks:       ${totalBookmarks} processed
  🐲  Dragon Minions:  ${tasksSpawned > 0 ? tasksSpawned + ' summoned' : 'solo hunt'}
  🏔️  Hoard Status:    ${hoardStatus}
${tokenDisplay}
  🐉 Smaug rests... until the next hoard arrives.

`);
          }
        } catch (e) {
          // JSON parse failed - silently ignore
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    const timeoutId = setTimeout(() => {
      stopSpinner();
      proc.kill('SIGTERM');
      resolve({
        success: false,
        error: `Timeout after ${timeout}ms`,
        stdout,
        stderr,
        exitCode: -1
      });
    }, timeout);

    proc.on('close', (code) => {
      stopSpinner();
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ success: true, output: stdout, tokenUsage });
      } else {
        resolve({
          success: false,
          error: `Exit code ${code}`,
          stdout,
          stderr,
          exitCode: code,
          tokenUsage
        });
      }
    });

    proc.on('error', (err) => {
      stopSpinner();
      clearTimeout(timeoutId);
      resolve({
        success: false,
        error: err.message,
        stdout,
        stderr,
        exitCode: -1
      });
    });
  });
}
```

### Modified Main Job Runner

In `run()` function, replace:

```javascript
// Old:
if (config.autoInvokeClaude !== false) {
  console.log(`[${now}] Phase 2: Invoking Claude Code for analysis...`);
  const claudeResult = await invokeClaudeCode(config, bookmarkCount, {
    trackTokens: options.trackTokens
  });
}

// New:
const provider = getAIProvider(config);
const providerName = provider === 'opencode' ? 'OpenCode' : 'Claude Code';

if (config.autoInvokeClaude !== false) {
  console.log(`[${now}] Phase 2: Invoking ${providerName} for analysis...`);
  const aiResult = await invokeAIProvider(config, bookmarkCount, {
    trackTokens: options.trackTokens
  });
}
```

---

## Phase 4: Updated Config Examples

### smaug.config.example.json

```json
{
  "source": "bookmarks",
  "archiveFile": "./bookmarks.md",
  "pendingFile": "./.state/pending-bookmarks.json",
  "stateFile": "./.state/bookmarks-state.json",
  "timezone": "America/New_York",
  "twitter": {
    "authToken": "your_auth_token",
    "ct0": "your_ct0"
  },
  "autoInvokeClaude": true,
  "parallelThreshold": 8,

  "aiProvider": "claude-code",

  "claudeCode": {
    "model": "sonnet",
    "allowedTools": "Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite"
  },

  "opencode": {
    "model": "openrouter/minimax/minimax-m2.1",
    "agent": "general-purpose",
    "subtask": true,
    "allowedTools": "Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite"
  },

  "webhookUrl": null,
  "webhookType": "discord"
}
```

---

## Phase 5: Updated README.md

Add new section:

```markdown
## OpenCode Integration

Smaug can use either Claude Code or OpenCode as its AI provider for bookmark processing.

### Setting Up OpenCode

1. **Install OpenCode:**
   ```bash
   curl -fsSL https://opencode.ai/install | bash
   ```

2. **Configure OpenCode:**
   ```bash
   opencode auth login
   # Or set API key in environment: OPENROUTER_API_KEY
   ```

3. **Initialize OpenCode for Smaug:**
   ```bash
   cd /path/to/smaug
   opencode /init
   ```

4. **Update smaug.config.json:**
   ```json
   {
     "aiProvider": "opencode",
     "opencode": {
       "model": "openrouter/minimax/minimax-m2.1",
       "agent": "general-purpose"
     }
   }
   ```

5. **Verify:**
   ```bash
   npx smaug run
   ```

### OpenCode Command File

Smaug creates `.opencode/commands/process-bookmarks.md` with instructions for OpenCode to process bookmarks. This file is automatically used when `aiProvider` is set to `"opencode"`.

### Switching Between Providers

| Config | Provider |
|--------|----------|
| `"aiProvider": "claude-code"` | Claude Code (default, existing behavior) |
| `"aiProvider": "opencode"` | OpenCode |

### Model Configuration

**Claude Code models:**
- `sonnet` (default)
- `haiku` (faster, cheaper)
- `opus` (most capable)

**OpenRouter models (via OpenCode):**
- `openrouter/minimax/minimax-m2.1` (recommended for Smaug)
- Any other OpenRouter-compatible model

Example:
```json
{
  "aiProvider": "opencode",
  "opencode": {
    "model": "openrouter/minimax/minimax-m2.1"
  }
}
```

### Token Usage Tracking

Both providers support token tracking with `-t` flag:

```bash
npx smaug run -t
```

Output shows input/output tokens and estimated cost based on provider pricing.

### Troubleshooting

**OpenCode not found:**
- Ensure OpenCode is installed: `which opencode`
- Add to PATH or use absolute path in config

**OpenCode authentication errors:**
- Run `opencode auth login` to configure credentials
- Or set `OPENROUTER_API_KEY` environment variable

**Parallel processing issues:**
- Ensure `subtask: true` is set in OpenCode config
- Check `.opencode/commands/process-bookmarks.md` exists
- Verify model supports subagent spawning
```

---

## Migration Steps

### Step 1: Backup Existing Files

```bash
cp .claude/commands/process-bookmarks.md .claude/commands/process-bookmarks-claude.md
```

### Step 2: Create OpenCode Command File

```bash
cat > .opencode/commands/process-bookmarks.md << 'EOF'
[Content from Phase 2]
EOF
```

### Step 3: Update Config Schema

Modify `src/config.js` to add helper functions and `smaug.config.example.json` to document new options.

### Step 4: Refactor job.js

Add `invokeOpenCode()` function and update `run()` to use `invokeAIProvider()`.

### Step 5: Update User Config

Update user's `smaug.config.json` with OpenCode options:

```json
{
  "aiProvider": "opencode",
  "opencode": {
    "model": "openrouter/minimax/minimax-m2.1"
  }
}
```

### Step 6: Test Both Providers

- [ ] Claude Code still works with `aiProvider: "claude-code"`
- [ ] OpenCode works with `aiProvider: "opencode"`
- [ ] Sequential processing (< 8 bookmarks) works for both
- [ ] Parallel processing (batch files) works for both
- [ ] Progress tracking displays correctly for both
- [ ] Token usage shows for both (where available)
- [ ] Error handling works for both providers

---

## Backward Compatibility

Existing configs continue to work without modification:

```json
{
  "claudeModel": "sonnet"  // Maps to claudeCode.model
}
```

Auto-detection:
- If `aiProvider` not set → defaults to `"claude-code"` (existing behavior)
- If `opencode.*` config exists → OpenCode available as option
- If `claudeCode.*` config exists → Claude Code options available

---

## Cost Estimation

### Mini Max M2.1 (OpenRouter)
- Input: $0.10 / 1M tokens
- Output: $0.10 / 1M tokens

### Comparison (20 bookmarks)
| Provider | Model | Est. Cost |
|----------|-------|-----------|
| Claude Code | sonnet | ~$0.50 |
| OpenCode | minimax-m2.1 | ~$0.05 |

OpenCode with Mini Max can be ~10x cheaper for bookmark processing.

---

## Future Enhancements (Out of Scope)

- [ ] OpenCode SDK integration for better session management
- [ ] Native OpenCode event parsing for progress tracking
- [ ] Support for OpenCode agents beyond `general-purpose`
- [ ] Per-batch model selection for hybrid processing
- [ ] Integration with OpenCode stats API for historical tracking

---

## Future: Backup & Restore Commands

### Implemented (Automatic)
- ✅ `backupBookmarks()` - Creates timestamped backup before every `run` and `reprocess`
- ✅ Backup location: `.state/backups/bookmarks-YYYY-MM-DDTHH-MM-SS.md`
- ✅ Retention: Keep all backups (no automatic cleanup)

### Planned Commands

#### `smaug backup`
Manual backup command for on-demand backups.

```bash
npx smaug backup                    # Create timestamped backup
npx smaug backup --name mybackup    # Create named backup
```

#### `smaug restore`
Restore from a previous backup.

```bash
npx smaug restore                   # List available backups
npx smaug restore --latest          # Restore most recent backup
npx smaug restore --file <path>     # Restore specific backup
npx smaug restore --date 2026-01-23 # Restore backup from specific date
```

#### `smaug backup --cleanup`
Optional cleanup of old backups.

```bash
npx smaug backup --cleanup --keep 30    # Keep last 30 backups
npx smaug backup --cleanup --days 90    # Keep backups from last 90 days
```

### Implementation Notes
- Backup files are in `.gitignore` (`.state/` directory)
- Each backup includes full `bookmarks.md` content
- Consider adding backup metadata (entry count, date range) in filename or separate manifest

---

## Future: Subject Tagging System

### Overview

Automatically categorize bookmarks by subject/topic (e.g., Geopolitics, AI, UAP, Security, Crypto). Tags enable filtering, searching, and organizing the bookmark archive.

### Design Decisions

| Aspect | Decision | Reasoning |
|--------|----------|-----------|
| **Tag Location** | Add `**Tags:** [[Tag1]] [[Tag2]]` line to bookmark entries | Obsidian-compatible, searchable, keeps data with entry |
| **Categorization Method** | Hybrid (keyword pre-filter + AI refinement) | Keywords are fast/free for obvious cases; AI handles ambiguous ones |
| **When to Tag** | Separate `smaug tag` command + optional during `run` | Allows batch tagging of existing bookmarks |
| **Tag Granularity** | Start with 10-15 broad categories | Can split later; easier to merge than subdivide |
| **Tag Index** | Optional tag index files in `tags/` directory | Enables browsing by topic |

### Proposed Tag Taxonomy

| Tag | Keywords/Patterns | Description |
|-----|-------------------|-------------|
| `[[Geopolitics]]` | iran, ukraine, russia, china, nato, military, war, sanctions, diplomacy | International relations, conflicts, military |
| `[[AI]]` | llm, gpt, claude, openai, anthropic, model, training, inference, neural | AI/ML technology and research |
| `[[AI-Tools]]` | github.com, tool, cli, library, framework, sdk, api | AI-related tools and software |
| `[[UAP]]` | uap, ufo, drone, orb, sighting, disclosure, congress, pentagon, nhi | Unidentified aerial phenomena |
| `[[Security]]` | hack, breach, vulnerability, exploit, malware, ransomware, cve | Cybersecurity, hacking, vulnerabilities |
| `[[Crypto]]` | bitcoin, ethereum, crypto, blockchain, defi, nft, wallet | Cryptocurrency and blockchain |
| `[[Science]]` | research, study, paper, discovery, nasa, space, physics | Scientific research and discoveries |
| `[[Tech]]` | startup, product, launch, apple, google, microsoft | Technology industry news |
| `[[Media]]` | video, podcast, interview, documentary | Media content (videos, podcasts) |
| `[[Opinion]]` | thread, take, rant, hot take, unpopular opinion | Commentary and opinion pieces |

### State Tracking

New state file: `.state/tag-state.json`

```json
{
  "version": 1,
  "lastRun": "2026-01-23T17:00:00.000Z",
  "taxonomy": {
    "Geopolitics": { "keywords": ["iran", "ukraine", ...], "count": 450 },
    "AI": { "keywords": ["llm", "gpt", ...], "count": 380 },
    ...
  },
  "entries": {
    "tweet_id_123": {
      "status": "tagged",
      "tags": ["Geopolitics", "UAP"],
      "method": "keyword",
      "taggedAt": "2026-01-23T17:00:00.000Z"
    },
    "tweet_id_456": {
      "status": "pending",
      "suggestedTags": ["AI"],
      "confidence": 0.3,
      "needsAI": true
    }
  },
  "stats": {
    "total": 3032,
    "tagged": 2500,
    "pending": 500,
    "untaggable": 32
  }
}
```

### CLI Commands

```bash
# Show tagging status
npx smaug tag --status

# Tag using keywords only (fast, free)
npx smaug tag --keywords --limit 100

# Tag using AI (slower, costs tokens)
npx smaug tag --ai --limit 50

# Tag using hybrid (keywords first, AI for uncertain)
npx smaug tag --limit 100

# Force re-tag all entries
npx smaug tag --force --limit 100

# Tag specific entries by pattern
npx smaug tag --match "drone|uap|ufo"

# List entries by tag
npx smaug tag --list Geopolitics

# Show tag statistics
npx smaug tag --stats
```

### Workflow

#### Phase 1: Keyword Tagging (Fast Pass)

1. Load bookmark entries from `bookmarks.md`
2. For each entry, check text against keyword patterns
3. If **high confidence** (multiple keyword matches): assign tags immediately
4. If **low confidence** (single weak match or none): mark as `needsAI: true`
5. Update `tag-state.json`
6. Add `**Tags:**` line to matching entries in `bookmarks.md`

#### Phase 2: AI Tagging (Refinement Pass)

1. Load entries marked `needsAI: true` from state
2. Batch entries (e.g., 20 at a time) and send to AI with:
   - Entry text
   - Available tags and descriptions
   - Instructions to assign 1-3 most relevant tags
3. Parse AI response and update entries
4. Update `tag-state.json` and `bookmarks.md`

### Entry Format (After Tagging)

```markdown
## @someuser - Tweet Title
> Tweet text content here...

- **Tweet:** https://x.com/someuser/status/123
- **Tags:** [[Geopolitics]] [[UAP]]
- **What:** Description of the tweet content
```

### Tag Index Files (Optional)

Create `tags/geopolitics.md`:

```markdown
# Geopolitics

Bookmarks related to international relations, military conflicts, and diplomacy.

## Recent Entries

- [[2026-01-23]] @user1 - Title about Iran
- [[2026-01-22]] @user2 - NATO response to...
...
```

### Configuration

Add to `smaug.config.json`:

```json
{
  "tagging": {
    "enabled": true,
    "autoTagOnRun": false,
    "taxonomy": "default",
    "customTags": {
      "MyTopic": {
        "keywords": ["keyword1", "keyword2"],
        "description": "Custom topic description"
      }
    },
    "aiThreshold": 0.5,
    "createIndexFiles": false
  }
}
```

### Integration with Media System

Add media-related tags to taxonomy:

| Tag | Auto-applied when |
|-----|-------------------|
| `[[Video]]` | Bookmark contains video content |
| `[[Image]]` | Bookmark contains significant image |
| `[[YouTube]]` | Link to YouTube video |
| `[[Podcast]]` | Audio content (future) |

### Implementation Phases

#### Phase 1: Core Tagging (MVP)
- [ ] Add `smaug tag --status` command
- [ ] Implement keyword-based tagging
- [ ] Create `tag-state.json` tracking
- [ ] Update `bookmarks.md` with Tags lines
- [ ] Add `--limit` support

#### Phase 2: AI Enhancement
- [ ] Add AI tagging for uncertain entries
- [ ] Implement batched AI requests
- [ ] Add confidence scoring
- [ ] Support `--ai` and `--keywords` flags

#### Phase 3: Advanced Features
- [ ] Tag index file generation
- [ ] Custom taxonomy support
- [ ] Auto-tagging during `run`
- [ ] Tag statistics and analytics
- [ ] Tag-based search/filter

### Cost Estimation

| Method | Speed | Cost | Accuracy |
|--------|-------|------|----------|
| Keywords only | ~1000/sec | Free | 70-80% |
| AI only | ~20/min | ~$0.50/1000 | 95%+ |
| Hybrid | ~100/min | ~$0.10/1000 | 90%+ |

For 3,032 bookmarks with hybrid approach:
- ~2,500 tagged by keywords (free)
- ~500 tagged by AI (~$0.25)

---

## Future: Media Handling System

### Overview

Download and archive media from bookmarks:
- **Images** (embedded in tweets) → `knowledge/images/`
- **Videos** (Twitter, YouTube, etc.) → `knowledge/videos/` via `yt-dlp`

### Media Detection

| Type | Detection Pattern | Action |
|------|-------------------|--------|
| Twitter image | `pic.twitter.com`, embedded media URLs | Download via direct URL |
| Twitter video | Tweet contains video indicator | `yt-dlp` the tweet URL |
| YouTube | `youtube.com`, `youtu.be` | `yt-dlp` the video |
| Other video | `vimeo.com`, `tiktok.com`, etc. | `yt-dlp` (supports 1000+ sites) |

### State Tracking

New state file: `.state/media-state.json`

```json
{
  "version": 1,
  "lastRun": "2026-01-23T17:00:00.000Z",
  "entries": {
    "tweet_id_123": {
      "tweetUrl": "https://x.com/user/status/123",
      "mediaType": "image",
      "status": "downloaded",
      "localPath": "knowledge/images/user-123-001.jpg",
      "downloadedAt": "2026-01-23T17:00:00.000Z"
    },
    "tweet_id_456": {
      "tweetUrl": "https://x.com/user/status/456",
      "mediaType": "video",
      "status": "pending",
      "sourceUrl": "https://x.com/user/status/456"
    }
  },
  "stats": {
    "images": { "total": 450, "downloaded": 200, "pending": 250, "failed": 0 },
    "videos": { "total": 100, "downloaded": 20, "pending": 75, "failed": 5 }
  }
}
```

### CLI Commands

```bash
# Show media status
npx smaug media --status

# Download images only
npx smaug media --images --limit 50

# Download videos only (uses yt-dlp)
npx smaug media --videos --limit 10

# Download all media types
npx smaug media --limit 50

# Retry failed downloads
npx smaug media --retry-failed

# Download media for specific bookmark
npx smaug media --tweet https://x.com/user/status/123
```

### Directory Structure

```
knowledge/
├── images/
│   ├── user1-tweetid-001.jpg
│   ├── user1-tweetid-002.png
│   └── ...
├── videos/
│   ├── user2-tweetid.mp4
│   ├── youtube-videoid.mp4
│   └── ...
├── tools/
│   └── ... (existing)
└── articles/
    └── ... (existing)
```

### File Naming Convention

**Images:** `{author}-{tweet_id}-{index}.{ext}`
- Example: `elonmusk-1234567890-001.jpg`

**Videos:** `{author}-{tweet_id}.{ext}` or `{platform}-{video_id}.{ext}`
- Example: `elonmusk-1234567890.mp4`
- Example: `youtube-dQw4w9WgXcQ.mp4`

### Bookmark Entry Update

After downloading, update the bookmark entry:

```markdown
## @user - Tweet Title
> Tweet text...

- **Tweet:** https://x.com/user/status/123
- **Tags:** [[Geopolitics]] [[Video]]
- **Media:** [video](knowledge/videos/user-123.mp4)
- **What:** Description
```

Or for images:
```markdown
- **Media:** [image](knowledge/images/user-123-001.jpg)
```

### Dependencies

- **yt-dlp** - Required for video downloads (Twitter, YouTube, etc.)
- **curl/wget** - For direct image downloads
- **Twitter auth cookies** - Same cookies used for `bird` CLI

### yt-dlp Integration

```bash
# Twitter video (uses cookies)
yt-dlp --cookies-from-browser chrome \
  -o "knowledge/videos/%(uploader)s-%(id)s.%(ext)s" \
  "https://x.com/user/status/123"

# YouTube video
yt-dlp -o "knowledge/videos/youtube-%(id)s.%(ext)s" \
  "https://youtube.com/watch?v=..."
```

### Implementation Phases

#### Phase 1: Image Downloads
- [ ] Detect image URLs in bookmarks
- [ ] Download images to `knowledge/images/`
- [ ] Update `media-state.json`
- [ ] Add `**Media:**` line to bookmark entries
- [ ] Add `--images` flag to CLI

#### Phase 2: Video Downloads
- [ ] Detect video content in bookmarks
- [ ] Integrate `yt-dlp` for downloads
- [ ] Handle Twitter videos (require auth cookies)
- [ ] Handle YouTube and other platforms
- [ ] Add `--videos` flag to CLI

#### Phase 3: Advanced Features
- [ ] Video transcription (whisper or API)
- [ ] Image description via AI vision
- [ ] Thumbnail generation for videos
- [ ] Media gallery view

### Configuration

Add to `smaug.config.json`:

```json
{
  "media": {
    "enabled": true,
    "autoDownloadOnRun": false,
    "imageQuality": "original",
    "videoQuality": "best",
    "maxVideoSize": "500M",
    "ytdlpPath": "yt-dlp",
    "cookiesFrom": "chrome"
  }
}
```

### Questions to Resolve

1. **Image quality**: Download original size or specific resolution?
2. **Video quality**: Best quality, or cap at 1080p to save space?
3. **Storage limits**: Set max file size or total storage limit?
4. **Duplicate handling**: Skip if already downloaded, or re-download?

---

## References

- [OpenCode CLI Docs](https://opencode.ai/docs/cli)
- [OpenCode Commands](https://opencode.ai/docs/commands)
- [OpenCode SDK](https://opencode.ai/docs/sdk)
- [OpenRouter Mini Max M2.1](https://openrouter.ai/models/minimax/minimax-m2.1)
