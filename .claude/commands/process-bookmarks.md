# /process-bookmarks

Process prepared Twitter bookmarks into a markdown archive with rich analysis and optional filing to a knowledge library.

## Before You Start

### Multi-Step Protocol (CRITICAL)

**Create todo list BEFORE starting.** This ensures final steps never get skipped.

```javascript
TodoWrite({
  todos: [
    {content: "Read pending bookmarks", status: "pending", activeForm: "Reading pending bookmarks"},
    {content: "Process and file bookmarks", status: "pending", activeForm: "Processing bookmarks"},
    {content: "Clean up pending file", status: "pending", activeForm: "Cleaning up pending file"},
    {content: "Commit and push changes", status: "pending", activeForm: "Committing changes"},
    {content: "Return summary", status: "pending", activeForm: "Returning summary"}
  ]
})
```

**Execution rules:**
- Mark each step `in_progress` before starting
- Mark `completed` immediately after finishing (no batching)
- Only ONE task `in_progress` at a time
- Never skip final steps (commit, summary)

### Setup

**Get today's date (friendly format):**
```bash
date +"%A, %B %-d, %Y"
```

Use this format for date section headers (e.g., "Thursday, January 2, 2026").

**Load categories from config:**
```bash
cat ./smaug.config.json | jq '.categories // empty'
```

If no custom categories, use the defaults from `src/config.js`.

## Input

Prepared bookmarks are in: `./.state/pending-bookmarks.json`

Each bookmark includes:
- `id`, `author`, `authorName`, `text`, `tweetUrl`, `date`
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

```bash
cat ./.state/pending-bookmarks.json
```

### 2. Process Bookmarks (Parallel for 3+)

**IMPORTANT: If there are 3 or more bookmarks, you MUST use parallel processing:**

```
Use the Task tool to spawn multiple subagents simultaneously.
Each subagent processes a batch of ~5 bookmarks.
Example: 20 bookmarks → spawn 4 subagents (5 each) in ONE message with multiple Task calls.
```

This is critical for performance. Do NOT process bookmarks sequentially when there are 3+.

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

Add to `./bookmarks.md`:

**CRITICAL ordering rules:**
1. Use the bookmark's `date` field from the JSON, format as friendly date
2. Check if that date section already exists near the TOP of the file
3. If it exists: insert the new entry immediately AFTER the `# Date` header (ABOVE existing entries)
4. If no section for that date: create new `# Weekday, Month Day, Year` section at the TOP
5. Do NOT create duplicate date sections - always check first

**Header hierarchy:**
- `# Thursday, January 2, 2026` - Date headers (h1)
- `## @author - title` - Individual bookmark entries (h2)

**Standard entry format:**
```markdown
## @{author} - {descriptive_title}
> {tweet_text}

- **Tweet:** {tweet_url}
- **Link:** {expanded_url}
- **Filed:** [{filename}](./knowledge/tools/{slug}.md) (if filed)
- **What:** {1-2 sentence description of what this actually is}
```

**For quote tweets, include the quoted content:**
```markdown
## @{author} - {descriptive_title}
> {tweet_text}
>
> *Quoting @{quoted_author}:* {quoted_text}

- **Tweet:** {tweet_url}
- **Quoted:** {quoted_tweet_url}
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
- **What:** {description}
```

Separate entries with `---` only between different dates, not between entries on the same day.

### 3. Clean Up Pending File

After successfully processing, remove the processed bookmarks from the pending file:

```javascript
const pending = JSON.parse(fs.readFileSync('./.state/pending-bookmarks.json', 'utf8'));
const processedIds = new Set([/* IDs you processed */]);
const remaining = pending.bookmarks.filter(b => !processedIds.has(b.id));
pending.bookmarks = remaining;
pending.count = remaining.length;
fs.writeFileSync('./.state/pending-bookmarks.json', JSON.stringify(pending, null, 2));
```

### 4. Commit and Push Changes

After all bookmarks are processed and filed, commit the changes:

```bash
# Get today's date for commit message
DATE=$(date +"%b %-d")

# Stage all bookmark-related changes
git add bookmarks.md
git add knowledge/

# Commit with descriptive message
git commit -m "Process N Twitter bookmarks from $DATE

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

# Push immediately
git push
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
tags: [{relevant_tags}]
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
tags: [{relevant_tags}]
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
tags: [{relevant_tags}]
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
tags: [{relevant_tags}]
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

## Parallel Processing (REQUIRED for 3+ bookmarks)

**You MUST spawn multiple Task subagents in a SINGLE message when processing 3+ bookmarks.**

Example for 20 bookmarks - send ONE message containing 4 Task tool calls:

```
Task 1: "Process bookmarks 1-5" with prompt containing bookmarks 1-5 JSON
Task 2: "Process bookmarks 6-10" with prompt containing bookmarks 6-10 JSON
Task 3: "Process bookmarks 11-15" with prompt containing bookmarks 11-15 JSON
Task 4: "Process bookmarks 16-20" with prompt containing bookmarks 16-20 JSON
```

Each subagent receives the full batch data and processes independently. They run in parallel.

**DO NOT:**
- Process bookmarks one at a time sequentially
- Spawn one Task and wait for it before spawning the next
- Skip parallel processing because it "seems simpler"

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

4. @CasJam: Claude Code Video Post-Production
   → Plain tweet (video content)
   → Captured only, flagged for transcript
```
