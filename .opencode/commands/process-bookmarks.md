---
description: Process Twitter bookmarks into markdown archive with AI analysis
agent: general
model: openrouter/minimax/minimax-m2.1
subtask: true
---

# /process-bookmarks

Process prepared Twitter bookmarks into a markdown archive with rich analysis and optional filing to a knowledge library.

---
## ⚠️ CRITICAL DATA SAFETY RULES ⚠️

**READ THIS BEFORE DOING ANYTHING:**

1. **NEVER overwrite bookmarks.md** - Always READ existing content first, then INSERT new entries
2. **VERIFY after every write** - Run `grep -c "^## @" bookmarks.md` before AND after. Count must increase!
3. **If count decreases = DATA LOSS** - Stop immediately and investigate
4. **Sequential is safer than parallel** - When in doubt, process one at a time

**Past failures:** Previous runs lost 1800+ entries by overwriting instead of merging. Don't repeat this mistake.

---

## Before You Start

### Multi-Step Parallel Protocol (CRITICAL)

**Create todo list IMMEDIATELY after reading bookmark count.** This ensures final steps never get skipped.

**Check parallelThreshold from config** (default: 100). **Sequential processing is strongly preferred** - it's safer and avoids complex merge logic that has caused data loss in the past. Only use parallel processing for very large batches (100+).

```bash
node -e "console.log(require('./smaug.config.json').parallelThreshold ?? 8)"
```

**For bookmarks below threshold (sequential):**
```javascript
TodoWrite({ todos: [
  {content: "Read pending bookmarks", id: "1", priority: "high", status: "pending"},
  {content: "Process bookmark 1", id: "2", priority: "high", status: "pending"},
  {content: "Process bookmark 2", id: "3", priority: "high", status: "pending"},
  {content: "Clean up batch files if created", id: "4", priority: "high", status: "pending"},
  {content: "Return summary", id: "5", priority: "high", status: "pending"}
]})
```

**For bookmarks at or above threshold (use OpenCode subagents with batch files):**
```javascript
TodoWrite({ todos: [
  {content: "Read pending bookmarks", id: "1", priority: "high", status: "pending"},
  {content: "Spawn subagents to write batch files", id: "2", priority: "high", status: "pending"},
  {content: "Wait for all subagents to complete", id: "3", priority: "high", status: "pending"},
  {content: "Merge batch files into bookmarks.md", id: "4", priority: "high", status: "pending"},
  {content: "Clean up batch files only", id: "5", priority: "high", status: "pending"},
  {content: "Return summary", id: "6", priority: "high", status: "pending"}
]})
```

**Execution rules:**
- Mark each step `in_progress` before starting (not implemented in TodoWrite, just track mentally)
- Mark `completed` immediately after finishing
- Only ONE task in_progress at a time
- Never skip the final summary step

**CRITICAL for parallel processing:** Use OpenCode's subagent system to spawn multiple agents in parallel. Each writes to a batch file:

```javascript
Task({
  subagent_type: "general",
  description: "Process batch 0",
  prompt: "Process these bookmarks and write markdown entries (no date headers) to .state/batch-0.md. Each entry: ---\nDATE: {date}\n## @{author} - {title}\n> {tweet text}\n\n- **Tweet:** {url}\n- **Tags:** [[tag1]] [[tag2]] (if tags exist)\n- **What:** {description}\n\nBookmarks: {JSON array}"
})
Task({
  subagent_type: "general",
  description: "Process batch 1",
  prompt: "Process these bookmarks and write markdown entries (no date headers) to .state/batch-1.md. Use the same format.\n\nBookmarks: {JSON array}"
})
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

#### b. Categorize and file (REQUIRED for matching URLs!)

**YOU MUST check each bookmark's links and create knowledge files for matches:**

| URL Pattern | Action | Create File At |
|-------------|--------|----------------|
| github.com | **MUST file** | ./knowledge/tools/{repo-name}.md |
| medium.com, substack.com, dev.to | **MUST file** | ./knowledge/articles/{slug}.md |
| youtube.com, youtu.be | transcribe flag | (optional placeholder) |
| Other URLs | capture only | No file needed |

**For each `file` action:**
1. Create the knowledge file using the template (see Frontmatter Templates section)
2. Add `- **Filed:** [{filename}]({path})` to the bookmark entry

**DO NOT skip filing for GitHub repos or articles.** This is a key feature.

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

#### d. VERIFY entry count (REQUIRED after each write)

**After EVERY write to bookmarks.md, verify the entry count:**

```bash
# Get current count
BEFORE=$(grep -c "^## @" bookmarks.md 2>/dev/null || echo "0")
# ... write new entry ...
AFTER=$(grep -c "^## @" bookmarks.md)
echo "Before: $BEFORE, After: $AFTER"
# AFTER must be >= BEFORE. If AFTER < BEFORE, STOP - you lost data!
```

**If count decreased:** DO NOT CONTINUE. Investigate what went wrong. Use `git diff bookmarks.md` to see what changed.

### 3. DO NOT Clean Up Pending File

**IMPORTANT:** Do NOT modify the pending file. The Smaug job handles cleanup automatically. Modifying the file here would cause race conditions and data corruption.

Just focus on processing the bookmarks and writing the results.

### 4. DO NOT Commit or Push

**IMPORTANT:** Do NOT run git commit or git push. The output files (bookmarks.md, knowledge/, .state/) are in .gitignore and should not be committed.

Just process the bookmarks and return a summary.

### 5. Return Summary

```
Processed N bookmarks:
- @author1: Tool Name → filed to knowledge/tools/tool-name.md
- @author2: Article Title → filed to knowledge/articles/article-slug.md
- @author3: Plain tweet → captured only
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
Task({
  subagent_type: "general",
  description: "Process batch 0",
  prompt: "Write to .state/batch-0.md: {JSON for 5-10 bookmarks}"
})
Task({
  subagent_type: "general",
  description: "Process batch 1",
  prompt: "Write to .state/batch-1.md: {JSON for next 5-10 bookmarks}"
})
Task({
  subagent_type: "general",
  description: "Process batch 2",
  prompt: "Write to .state/batch-2.md: {JSON for next 5-10 bookmarks}"
})
Task({
  subagent_type: "general",
  description: "Process batch 3",
  prompt: "Write to .state/batch-3.md: {JSON for remaining bookmarks}"
})
```

**Subagent prompt template:**
```
Process these bookmarks. You have TWO jobs:

## JOB 1: Write batch file
Write markdown entries to .state/batch-{N}.md (no date headers)

## JOB 2: Create knowledge files (REQUIRED for matching URLs!)
For EACH bookmark with these URLs, you MUST create a knowledge file:
- github.com → Create ./knowledge/tools/{repo-name}.md
- medium.com, substack.com, dev.to → Create ./knowledge/articles/{slug}.md

Use the templates at the end of this prompt.

Bookmarks to process (in order - oldest first):
{JSON array of 5-10 bookmarks}

## Batch file entry format:
---
DATE: {bookmark.date}
## @{author} - {title}
> {tweet text}

- **Tweet:** {url}
- **Tags:** [[tag1]] [[tag2]] (if tags exist)
- **Filed:** [{filename}]({path}) ← ADD THIS if you created a knowledge file!
- **What:** {description}

## Tool template (./knowledge/tools/{slug}.md):
---
title: "{repo_name}"
type: tool
date_added: {YYYY-MM-DD}
source: "{github_url}"
via: "Twitter bookmark from @{author}"
---
{Description of what the tool does}
## Links
- [GitHub]({github_url})
- [Original Tweet]({tweet_url})

## Article template (./knowledge/articles/{slug}.md):
---
title: "{article_title}"
type: article
date_added: {YYYY-MM-DD}
source: "{article_url}"
via: "Twitter bookmark from @{author}"
---
{Summary of the article}
## Links
- [Article]({article_url})
- [Original Tweet]({tweet_url})

DO NOT touch bookmarks.md - only write to .state/batch-{N}.md and knowledge/ files
```

**Phase 2: Sequential merge (main agent combines batches)**

**CRITICAL: YOU MUST PRESERVE ALL EXISTING CONTENT IN bookmarks.md**

The merge step is the most important part. If you overwrite or lose existing entries, data is permanently lost.

After ALL subagents complete:
1. **Read the ENTIRE existing bookmarks.md first** - store all content in memory
2. Read all .state/batch-*.md files in order (batch-0, batch-1, batch-2...)
3. Parse each entry (separated by `---`) and extract the DATE line
4. **INSERT** each new entry into the existing content at correct chronological position
5. Write the **combined** result (old + new) back to bookmarks.md
6. Delete the temp batch files only AFTER confirming the merge succeeded

**Merge algorithm (pseudocode):**
```javascript
// Step 1: Read existing content
const existingContent = fs.readFileSync('bookmarks.md', 'utf8');
const existingSections = parseIntoDateSections(existingContent); // Map<date, entries[]>

// Step 2: Read batch files
const batchFiles = glob.sync('.state/batch-*.md').sort();
for (const batchFile of batchFiles) {
  const entries = parseBatchFile(batchFile);
  for (const entry of entries) {
    // INSERT entry into existingSections at correct date
    if (!existingSections.has(entry.date)) {
      existingSections.set(entry.date, []);
    }
    existingSections.get(entry.date).unshift(entry); // Add at TOP of date section
  }
}

// Step 3: Rebuild file in chronological order (newest first)
const sortedDates = [...existingSections.keys()].sort((a, b) => new Date(b) - new Date(a));
const mergedContent = sortedDates.map(date => {
  return `# ${date}\n` + existingSections.get(date).join('\n');
}).join('\n---\n');

// Step 4: Write merged content
fs.writeFileSync('bookmarks.md', mergedContent);
```

**Verification step (REQUIRED):**
After merging, count entries with `grep -c "^## @" bookmarks.md`. The count should be:
- Previous count + new entries processed
- If the count is LOWER than before, the merge FAILED - investigate immediately!

**DO NOT:**
- Have subagents write directly to bookmarks.md (causes race conditions)
- Process all bookmarks sequentially (too slow)
- Skip the merge step
- **OVERWRITE bookmarks.md without reading existing content first**
- **Lose any existing entries during merge**

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
