/**
 * Smaug Scheduled Job
 *
 * Full two-phase workflow:
 * 1. Fetch bookmarks, expand links, extract content
 * 2. Invoke Claude Code for analysis and filing
 *
 * Can be used with:
 * - Cron: "0,30 * * * *" (every 30 min) - node /path/to/smaug/src/job.js
 * - Bree: Import and add to your Bree jobs array
 * - systemd timers: See README for setup
 * - Any other scheduler
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fetchAndPrepareBookmarks } from './processor.js';
import { loadConfig, getAIProvider, getOpenCodeConfig, getClaudeCodeConfig } from './config.js';

const JOB_NAME = 'smaug-oc';
const LOCK_FILE = path.join(os.tmpdir(), 'smaug-oc.lock');

// ============================================================================
// Lock Management - Prevents overlapping runs
// ============================================================================

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const { pid, timestamp } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      try {
        process.kill(pid, 0); // Check if process exists
        const age = Date.now() - timestamp;
        if (age < 20 * 60 * 1000) { // 20 minute timeout
          console.log(`[${JOB_NAME}] Previous run still in progress (PID ${pid}). Skipping.`);
          return false;
        }
        console.log(`[${JOB_NAME}] Stale lock found (${Math.round(age / 60000)}min old). Overwriting.`);
      } catch (e) {
        console.log(`[${JOB_NAME}] Removing stale lock (PID ${pid} no longer running)`);
      }
    } catch (e) {
      // Invalid lock file
    }
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
  return true;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const { pid } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (e) {}
}

// ============================================================================
// Backup Management - Creates timestamped backups before processing
// ============================================================================

function backupBookmarks(config) {
  const archiveFile = config.archiveFile;
  
  // Skip if bookmarks.md doesn't exist or is empty
  if (!fs.existsSync(archiveFile)) {
    return null;
  }
  
  const content = fs.readFileSync(archiveFile, 'utf8');
  if (!content.trim()) {
    return null;
  }
  
  // Create backups directory
  const stateDir = path.dirname(config.pendingFile);
  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  
  // Create timestamped backup filename
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const backupPath = path.join(backupDir, `bookmarks-${timestamp}.md`);
  
  // Copy the file
  fs.copyFileSync(archiveFile, backupPath);
  
  const entryCount = (content.match(/^## @/gm) || []).length;
  console.log(`[backup] Created ${backupPath} (${entryCount} entries)`);
  
  return backupPath;
}

// ============================================================================
// Reprocess State Management
// ============================================================================

const MAX_RETRY_ATTEMPTS = 5;

function getReprocessStatePath(config) {
  const stateDir = path.dirname(config.pendingFile);
  return path.join(stateDir, 'reprocess-state.json');
}

function loadReprocessState(config) {
  const statePath = getReprocessStatePath(config);
  
  if (fs.existsSync(statePath)) {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (e) {
      console.warn('[reprocess] Invalid state file, creating new one');
    }
  }
  
  return {
    version: 1,
    lastRun: null,
    currentJob: null,
    entries: {},
    stats: {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      in_progress: 0,
      skipped: 0
    }
  };
}

function saveReprocessState(config, state) {
  const statePath = getReprocessStatePath(config);
  
  // Recalculate stats
  const entries = Object.values(state.entries);
  state.stats = {
    total: entries.length,
    completed: entries.filter(e => e.status === 'completed').length,
    failed: entries.filter(e => e.status === 'failed').length,
    pending: entries.filter(e => e.status === 'pending').length,
    in_progress: entries.filter(e => e.status === 'in_progress').length,
    skipped: entries.filter(e => e.status === 'skipped').length
  };
  
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function syncReprocessState(config, state) {
  // Scan bookmarks.md for entries needing knowledge files
  const archiveFile = config.archiveFile;
  if (!fs.existsSync(archiveFile)) {
    return state;
  }
  
  const content = fs.readFileSync(archiveFile, 'utf8');
  
  // Find all bookmark entries
  const entryPattern = /## @[\s\S]*?(?=\n## @|\n# |\n---\n# |$)/g;
  const entries = content.match(entryPattern) || [];
  
  // Patterns for knowledge-worthy URLs
  const knowledgePatterns = [
    { pattern: /github\.com\/[\w-]+\/[\w-]+(?:\/[^\s\n)\]]*)?/gi, type: 'github' },
    { pattern: /[\w-]+\.medium\.com\/[^\s\n)\]]+/gi, type: 'article' },
    { pattern: /medium\.com\/@?[\w-]+\/[^\s\n)\]]+/gi, type: 'article' },
    { pattern: /[\w-]+\.substack\.com\/p\/[^\s\n)\]]+/gi, type: 'article' },
    { pattern: /substack\.com\/[^\s\n)\]]+/gi, type: 'article' },
    { pattern: /dev\.to\/[\w-]+\/[^\s\n)\]]+/gi, type: 'article' }
  ];
  
  // URLs to ignore (not actual content)
  const ignorePatterns = [
    /github\.com\/.*\/commit\//i,  // Individual commits
    /github\.com\/.*\/issues\//i,  // Issues
    /github\.com\/.*\/pull\//i,    // PRs
    /t\.co\//i,                    // Twitter shortened links
    /x\.com\//i,                   // Twitter/X links
    /twitter\.com\//i              // Twitter links
  ];
  
  const foundLinks = new Set();
  
  for (const entry of entries) {
    // Check if already has Filed: line
    const hasFiled = /\*\*Filed:\*\*/i.test(entry);
    
    // Extract metadata
    const authorMatch = entry.match(/## @(\w+)/);
    const tweetMatch = entry.match(/\*\*Tweet:\*\*\s*(https?:\/\/[^\s\n]+)/);
    const textMatch = entry.match(/^## @\w+[^\n]*\n>\s*([^\n]+)/m);
    
    // First check the **Link:** field (preferred, already extracted)
    const linkFieldMatch = entry.match(/\*\*Link:\*\*\s*(https?:\/\/[^\s\n]+)/);
    
    // Collect all potential knowledge-worthy URLs from the entire entry
    const potentialLinks = [];
    
    // Check Link field first
    if (linkFieldMatch) {
      potentialLinks.push({ url: linkFieldMatch[1], source: 'link_field' });
    }
    
    // Also scan the entire entry text for URLs
    for (const { pattern, type } of knowledgePatterns) {
      const matches = entry.matchAll(pattern);
      for (const match of matches) {
        // Clean up the URL (remove trailing punctuation)
        let url = match[0].replace(/[.,;:!?)>\]]+$/, '');
        
        // Ensure it starts with https://
        if (!url.startsWith('http')) {
          url = 'https://' + url;
        }
        
        potentialLinks.push({ url, type, source: 'text' });
      }
    }
    
    // Process each potential link
    for (const { url, type: urlType, source } of potentialLinks) {
      // Skip ignored patterns
      if (ignorePatterns.some(p => p.test(url))) {
        continue;
      }
      
      // Determine type if not already set
      let linkType = urlType;
      if (!linkType) {
        if (/github\.com/i.test(url)) linkType = 'github';
        else if (/medium\.com/i.test(url)) linkType = 'article';
        else if (/substack\.com/i.test(url)) linkType = 'article';
        else if (/dev\.to/i.test(url)) linkType = 'article';
        else continue; // Skip if we can't determine type
      }
      
      foundLinks.add(url);
      
      // If not in state, add as pending (or completed if has Filed)
      if (!state.entries[url]) {
        state.entries[url] = {
          author: authorMatch ? authorMatch[1] : 'unknown',
          tweetUrl: tweetMatch ? tweetMatch[1] : null,
          text: textMatch ? textMatch[1].slice(0, 100) : '',
          type: linkType,
          source: source, // Track where we found it
          status: hasFiled ? 'completed' : 'pending',
          addedAt: new Date().toISOString(),
          attempts: 0
        };
      } else if (hasFiled && state.entries[url].status !== 'completed') {
        // Entry now has Filed: line, mark as completed
        state.entries[url].status = 'completed';
        state.entries[url].processedAt = new Date().toISOString();
      }
    }
  }
  
  // Mark entries no longer in bookmarks.md as removed (but keep in state for history)
  for (const link of Object.keys(state.entries)) {
    if (!foundLinks.has(link) && state.entries[link].status !== 'completed') {
      state.entries[link].status = 'removed';
    }
  }
  
  return state;
}

function getEntriesToProcess(state, options = {}) {
  const { force = false, limit = null } = options;
  
  const entries = [];
  
  for (const [link, entry] of Object.entries(state.entries)) {
    // Skip removed entries
    if (entry.status === 'removed') continue;
    
    // With --force, include everything except removed
    if (force) {
      if (entry.status !== 'removed') {
        entries.push({ link, ...entry });
      }
      continue;
    }
    
    // Normal mode: include pending, in_progress, and failed (under max attempts)
    if (entry.status === 'pending' || entry.status === 'in_progress') {
      entries.push({ link, ...entry });
    } else if (entry.status === 'failed' && (entry.attempts || 0) < MAX_RETRY_ATTEMPTS) {
      entries.push({ link, ...entry });
    }
    // Skip completed and skipped
  }
  
  // Sort: in_progress first (resume), then failed (retry), then pending
  entries.sort((a, b) => {
    const order = { in_progress: 0, failed: 1, pending: 2, completed: 3 };
    return (order[a.status] || 99) - (order[b.status] || 99);
  });
  
  // Apply limit
  if (limit && limit > 0) {
    return entries.slice(0, limit);
  }
  
  return entries;
}

function markEntriesInProgress(state, entries) {
  const now = new Date().toISOString();
  
  state.currentJob = {
    startedAt: now,
    entries: entries.map(e => e.link),
    count: entries.length
  };
  
  for (const entry of entries) {
    if (state.entries[entry.link]) {
      state.entries[entry.link].status = 'in_progress';
      state.entries[entry.link].startedAt = now;
      state.entries[entry.link].attempts = (state.entries[entry.link].attempts || 0) + 1;
    }
  }
  
  return state;
}

function verifyAndUpdateState(config, state) {
  const archiveFile = config.archiveFile;
  const content = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, 'utf8') : '';
  const now = new Date().toISOString();
  
  // Check each in_progress entry
  for (const [link, entry] of Object.entries(state.entries)) {
    if (entry.status !== 'in_progress') continue;
    
    // Check if Filed: line exists for this entry
    // We look for the link in a Filed: line
    const fileSlug = link.split('/').pop().replace(/[^a-zA-Z0-9-]/g, '');
    const hasFiledLine = content.includes(`**Filed:**`) && 
      (content.includes(link) || content.includes(fileSlug));
    
    // Check if knowledge file exists
    const knowledgeDir = entry.type === 'github' ? 'knowledge/tools' : 'knowledge/articles';
    const knowledgeFiles = fs.existsSync(knowledgeDir) ? fs.readdirSync(knowledgeDir) : [];
    const hasKnowledgeFile = knowledgeFiles.some(f => 
      f.toLowerCase().includes(fileSlug.toLowerCase().slice(0, 20))
    );
    
    if (hasFiledLine || hasKnowledgeFile) {
      // Success
      state.entries[link].status = 'completed';
      state.entries[link].processedAt = now;
      delete state.entries[link].startedAt;
      delete state.entries[link].error;
    } else {
      // Failed
      state.entries[link].status = 'failed';
      state.entries[link].lastAttemptAt = now;
      state.entries[link].error = 'Knowledge file or Filed line not created';
      delete state.entries[link].startedAt;
      
      // Check if max attempts reached
      if ((state.entries[link].attempts || 0) >= MAX_RETRY_ATTEMPTS) {
        state.entries[link].status = 'skipped';
        state.entries[link].error = `Max attempts (${MAX_RETRY_ATTEMPTS}) reached`;
      }
    }
  }
  
  // Clear current job
  state.currentJob = null;
  state.lastRun = now;
  
  return state;
}

function formatReprocessStatus(state) {
  const lines = [];
  
  lines.push('🐉 Reprocess Status\n');
  lines.push(`Last run: ${state.lastRun ? new Date(state.lastRun).toLocaleString() : 'Never'}`);
  lines.push('');
  lines.push('Summary:');
  lines.push(`  ✓ Completed:    ${state.stats.completed}`);
  lines.push(`  ✗ Failed:       ${state.stats.failed}`);
  lines.push(`  ⏳ Pending:      ${state.stats.pending}`);
  lines.push(`  🔄 In Progress:  ${state.stats.in_progress}`);
  if (state.stats.skipped > 0) {
    lines.push(`  ⏭ Skipped:      ${state.stats.skipped}`);
  }
  lines.push(`  ─────────────────`);
  lines.push(`  Total:          ${state.stats.total}`);
  
  // Show in_progress entries (potential interrupted job)
  const inProgress = Object.entries(state.entries)
    .filter(([_, e]) => e.status === 'in_progress');
  if (inProgress.length > 0) {
    lines.push('');
    lines.push('In Progress (interrupted?):');
    for (const [link, entry] of inProgress) {
      lines.push(`  • @${entry.author}: ${link.slice(0, 60)}...`);
      lines.push(`    Started: ${new Date(entry.startedAt).toLocaleString()}`);
    }
  }
  
  // Show failed entries
  const failed = Object.entries(state.entries)
    .filter(([_, e]) => e.status === 'failed');
  if (failed.length > 0) {
    lines.push('');
    lines.push('Failed:');
    for (const [link, entry] of failed.slice(0, 5)) {
      lines.push(`  • @${entry.author}: ${link.slice(0, 50)}...`);
      lines.push(`    ${entry.error || 'Unknown error'} (${entry.attempts || 1} attempts)`);
    }
    if (failed.length > 5) {
      lines.push(`  ... and ${failed.length - 5} more`);
    }
  }
  
  // Show pending entries
  const pending = Object.entries(state.entries)
    .filter(([_, e]) => e.status === 'pending');
  if (pending.length > 0) {
    lines.push('');
    lines.push('Pending:');
    for (const [link, entry] of pending.slice(0, 5)) {
      lines.push(`  • @${entry.author}: ${link.slice(0, 60)}...`);
    }
    if (pending.length > 5) {
      lines.push(`  ... and ${pending.length - 5} more`);
    }
  }
  
  // Show skipped entries
  const skipped = Object.entries(state.entries)
    .filter(([_, e]) => e.status === 'skipped');
  if (skipped.length > 0) {
    lines.push('');
    lines.push(`Skipped (max ${MAX_RETRY_ATTEMPTS} attempts):`);
    for (const [link, entry] of skipped.slice(0, 3)) {
      lines.push(`  • @${entry.author}: ${link.slice(0, 60)}...`);
    }
    if (skipped.length > 3) {
      lines.push(`  ... and ${skipped.length - 3} more`);
    }
  }
  
  if (state.stats.pending > 0 || state.stats.failed > 0 || state.stats.in_progress > 0) {
    lines.push('');
    lines.push("Run 'npx smaug reprocess --limit 5' to continue processing.");
  } else if (state.stats.total === 0) {
    lines.push('');
    lines.push('No entries found needing knowledge files.');
  } else {
    lines.push('');
    lines.push('All entries processed!');
  }
  
  return lines.join('\n');
}

// ============================================================================
// Claude Code Invocation
// ============================================================================

async function invokeClaudeCode(config, bookmarkCount, options = {}) {
  const timeout = config.claudeTimeout || 900000; // 15 minutes default
  const model = config.claudeModel || 'sonnet'; // or 'haiku' for faster/cheaper
  const trackTokens = options.trackTokens || false;

  // Specific tool permissions instead of full YOLO mode
  // Task is needed for parallel subagent processing
  const allowedTools = config.allowedTools || 'Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite';

  // Find claude binary - check common locations
  let claudePath = 'claude';
  const possiblePaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(process.env.HOME || '', '.claude/local/claude'),
    path.join(process.env.HOME || '', '.local/bin/claude'),
    path.join(process.env.HOME || '', 'Library/Application Support/Herd/config/nvm/versions/node/v20.19.4/bin/claude'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      claudePath = p;
      break;
    }
  }
  // Also check via which if we haven't found it
  if (claudePath === 'claude') {
    try {
      claudePath = execSync('which claude', { encoding: 'utf8' }).trim() || 'claude';
    } catch {
      // which failed, stick with 'claude'
    }
  }

  // Dramatic dragon reveal with fire animation
  const showDragonReveal = async (totalBookmarks) => {
    // Fire animation for 1.5 seconds
    process.stdout.write('\n');
    const fireFramesIntro = ['🔥', '🔥🔥', '🔥🔥🔥', '🔥🔥🔥🔥', '🔥🔥🔥🔥🔥'];
    for (let i = 0; i < 10; i++) {
      const frame = fireFramesIntro[i % fireFramesIntro.length];
      process.stdout.write(`\r  ${frame.padEnd(12)}`);
      await new Promise(r => setTimeout(r, 150));
    }

    // Clear and reveal
    process.stdout.write('\r                    \r');
    process.stdout.write(`  Wait... that's not Claude... it's

  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥
       _____ __  __   _   _   _  ____
      / ____|  \\/  | / \\ | | | |/ ___|
      \\___ \\| |\\/| |/ _ \\| | | | |  _
       ___) | |  | / ___ \\ |_| | |_| |
      |____/|_|  |_/_/  \\_\\___/ \\____|

  🐉 The dragon stirs... ${totalBookmarks} treasure${totalBookmarks !== 1 ? 's' : ''} to hoard!
`);
  };

  await showDragonReveal(bookmarkCount);

  return new Promise((resolve) => {
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--model', model,
      '--allowedTools', allowedTools,
      '--',
      `Process the ${bookmarkCount} bookmark(s) in ./.state/pending-bookmarks.json following the instructions in ./.claude/commands/process-bookmarks.md. Read that file first, then process each bookmark.`
    ];

    // Ensure PATH includes common node locations for the claude shebang
    const nodePaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      process.env.NVM_BIN,
      path.join(process.env.HOME || '', 'Library/Application Support/Herd/config/nvm/versions/node/v20.19.4/bin'),
      path.join(process.env.HOME || '', '.local/bin'),
      path.join(process.env.HOME || '', '.bun/bin'),
    ];
    const enhancedPath = [...nodePaths, process.env.PATH || ''].join(':');

    // Get ANTHROPIC_API_KEY from config or env only
    // Note: Don't parse from ~/.zshrc - OAuth tokens (sk-ant-oat01-*) might be
    // incorrectly stored there and would override valid OAuth credentials
    const apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

    // Build clean environment, removing nested Claude detection vars
    // These vars can cause issues when Claude is spawned from within another Claude session
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(claudePath, args, {
      cwd: config.projectRoot || process.cwd(),
      env: {
        ...cleanEnv,
        PATH: enhancedPath,
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {})
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
    const parallelTasks = new Map(); // taskId -> { description, startTime, status }
    let tasksSpawned = 0;
    let tasksCompleted = 0;

    // Token usage tracking
    const tokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      subagentInput: 0,
      subagentOutput: 0,
      model: model,
      subagentModel: null
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

    // Animated fire spinner with rotating dragon messages
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

    // Change message every 10 seconds
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
      process.stdout.write(spinnerLine + '          '); // Extra spaces to clear previous longer messages
      lastSpinnerLine = spinnerLine;
    }, 150);

    // Start the spinner with a patience message
    process.stdout.write('\n  ⏳ Dragons are patient hunters... this may take a moment.\n');
    lastSpinnerLine = '  🔥     Processing...';
    process.stdout.write(lastSpinnerLine);

    // Helper to clear spinner and print a status line
    const printStatus = (msg) => {
      // Clear current line and print message
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      process.stdout.write(msg);
    };

    // Helper to stop spinner completely
    const stopSpinner = () => {
      spinnerActive = false;
      clearInterval(spinnerInterval);
      clearInterval(msgInterval);
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    };

    // Buffer for incomplete JSON lines
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      // Handle streaming data that may split across chunks
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      // Keep the last incomplete line in the buffer
      lineBuffer = lines.pop() || '';

      // Parse streaming JSON and extract progress info
      for (const line of lines) {
        if (!line.trim()) continue;

        // Skip lines that don't look like JSON events
        if (!line.startsWith('{')) continue;

        try {
          const event = JSON.parse(line);

          // Show assistant text as it streams (filtered)
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text !== lastText) {
                const newPart = block.text.slice(lastText.length);
                if (newPart && newPart.length > 50) {
                  // Only show final summaries
                  if (newPart.includes('Processed') && newPart.includes('bookmark')) {
                    process.stdout.write(`\n💬 ${newPart.trim().slice(0, 200)}${newPart.length > 200 ? '...' : ''}\n`);
                  }
                }
                lastText = block.text;
              }

              // Track tool usage for progress messages
              if (block.type === 'tool_use') {
                const toolName = block.name;
                const input = block.input || {};

                if (toolName === 'Write' && input.file_path) {
                  const fileName = input.file_path.split('/').pop();
                  const dir = input.file_path.includes('/knowledge/tools/') ? 'tools' :
                             input.file_path.includes('/knowledge/articles/') ? 'articles' : '';
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
                } else if (toolName === 'Edit' && input.file_path) {
                  const fileName = input.file_path.split('/').pop();
                  if (fileName === 'bookmarks.md') {
                    bookmarksProcessed++;
                    const fireIntensity = '🔥'.repeat(Math.min(Math.ceil(bookmarksProcessed / 2), 5));
                    printStatus(`  ${fireIntensity} ${progressBar(bookmarksProcessed, totalBookmarks)} [${elapsed()}]`);
                  } else if (fileName === 'pending-bookmarks.json') {
                    printStatus(`  🐉 *licks claws clean* Tidying the lair...\n`);
                  }
                } else if (toolName === 'Read' && input.file_path) {
                  const fileName = input.file_path.split('/').pop();
                  if (fileName === 'pending-bookmarks.json' && !shownMessages.has('eye')) {
                    shownMessages.add('eye');
                    printStatus(`  👁️  The dragon's eye opens... surveying treasures...\n`);
                  } else if (fileName === 'process-bookmarks.md' && !shownMessages.has('scrolls')) {
                    shownMessages.add('scrolls');
                    printStatus(`  📜 Consulting the ancient scrolls...\n`);
                  }
                } else if (toolName === 'Task') {
                  const desc = input.description || `batch ${tasksSpawned + 1}`;
                  // Only count if we haven't seen this task description
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
          }

          // Track task completions from tool results
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && !block.is_error && block.tool_use_id) {
                // Check if this looks like a Task completion and we haven't counted it
                const content = typeof block.content === 'string' ? block.content : '';
                const toolId = block.tool_use_id;
                if ((content.includes('Processed') || content.includes('completed')) &&
                    !shownMessages.has(`task-done-${toolId}`)) {
                  shownMessages.add(`task-done-${toolId}`);
                  tasksCompleted++;
                  if (tasksSpawned > 0 && tasksCompleted <= tasksSpawned) {
                    const pct = Math.round((tasksCompleted / tasksSpawned) * 100);
                    const flames = '🔥'.repeat(Math.ceil(pct / 20));
                    printStatus(`  🐲 Dragon minion returns! ${flames} (${tasksCompleted}/${tasksSpawned})\n`);
                  }
                }
              }
            }
          }

          // Track token usage from result event
          if (event.type === 'result' && event.usage) {
            tokenUsage.input = event.usage.input_tokens || 0;
            tokenUsage.output = event.usage.output_tokens || 0;
            tokenUsage.cacheRead = event.usage.cache_read_input_tokens || 0;
            tokenUsage.cacheWrite = event.usage.cache_creation_input_tokens || 0;
          }

          // Track subagent token usage from Task results
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && block.content) {
                // Try to parse subagent usage from result
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                const usageMatch = content.match(/usage.*?input.*?(\d+).*?output.*?(\d+)/i);
                if (usageMatch) {
                  tokenUsage.subagentInput += parseInt(usageMatch[1], 10);
                  tokenUsage.subagentOutput += parseInt(usageMatch[2], 10);
                }
                // Detect subagent model from content
                if (!tokenUsage.subagentModel && content.includes('haiku')) {
                  tokenUsage.subagentModel = 'haiku';
                } else if (!tokenUsage.subagentModel && content.includes('sonnet')) {
                  tokenUsage.subagentModel = 'sonnet';
                }
              }
            }
          }

          // Show result summary
          if (event.type === 'result') {
            stopSpinner();

            // Randomized hoard descriptions by size tier
            const hoardDescriptions = {
              small: [
                'A Few Coins',
                'Sparse',
                'Humble Beginnings',
                'First Treasures',
                'A Modest Start'
              ],
              medium: [
                'Glittering',
                'Growing Nicely',
                'Respectable Pile',
                'Gleaming Hoard',
                'Handsome Collection'
              ],
              large: [
                'Overflowing',
                'Mountain of Gold',
                'Legendary Hoard',
                'Dragon\'s Fortune',
                'Vast Riches'
              ]
            };

            const tier = totalBookmarks > 15 ? 'large' : totalBookmarks > 7 ? 'medium' : 'small';
            const descriptions = hoardDescriptions[tier];
            const hoardStatus = descriptions[Math.floor(Math.random() * descriptions.length)];

            // Build token usage display if tracking enabled
            let tokenDisplay = '';
            if (trackTokens && (tokenUsage.input > 0 || tokenUsage.output > 0)) {
              // Pricing per million tokens (as of 2024)
              const pricing = {
                'sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
                'haiku': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.30 },
                'opus': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }
              };

              const mainPricing = pricing[tokenUsage.model] || pricing.sonnet;
              const subPricing = pricing[tokenUsage.subagentModel || tokenUsage.model] || mainPricing;

              // Calculate costs
              const mainInputCost = (tokenUsage.input / 1_000_000) * mainPricing.input;
              const mainOutputCost = (tokenUsage.output / 1_000_000) * mainPricing.output;
              const cacheReadCost = (tokenUsage.cacheRead / 1_000_000) * mainPricing.cacheRead;
              const cacheWriteCost = (tokenUsage.cacheWrite / 1_000_000) * mainPricing.cacheWrite;
              const subInputCost = (tokenUsage.subagentInput / 1_000_000) * subPricing.input;
              const subOutputCost = (tokenUsage.subagentOutput / 1_000_000) * subPricing.output;

              const totalCost = mainInputCost + mainOutputCost + cacheReadCost + cacheWriteCost + subInputCost + subOutputCost;

              const formatNum = (n) => n.toLocaleString();
              const formatCost = (c) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;

              tokenDisplay = `
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📊 TOKEN USAGE
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Main (${tokenUsage.model}):
    Input:       ${formatNum(tokenUsage.input).padStart(10)} tokens  ${formatCost(mainInputCost)}
    Output:      ${formatNum(tokenUsage.output).padStart(10)} tokens  ${formatCost(mainOutputCost)}
    Cache Read:  ${formatNum(tokenUsage.cacheRead).padStart(10)} tokens  ${formatCost(cacheReadCost)}
    Cache Write: ${formatNum(tokenUsage.cacheWrite).padStart(10)} tokens  ${formatCost(cacheWriteCost)}
${tokenUsage.subagentInput > 0 || tokenUsage.subagentOutput > 0 ? `
  Subagents (${tokenUsage.subagentModel || 'unknown'}):
    Input:       ${formatNum(tokenUsage.subagentInput).padStart(10)} tokens  ${formatCost(subInputCost)}
    Output:      ${formatNum(tokenUsage.subagentOutput).padStart(10)} tokens  ${formatCost(subOutputCost)}
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
          // JSON parse failed - silently ignore (don't print raw JSON)
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
        exitCode: -1,
        duration: Date.now() - startTime
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
        exitCode: -1,
        duration: Date.now() - startTime
      });
    });
  });
}

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

// ============================================================================
// OpenCode Invocation
// ============================================================================

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
    const prompt = `Process the ${bookmarkCount} bookmark(s) in ./.state/pending-bookmarks.json following the instructions in ./.opencode/commands/process-bookmarks.md. Read that file first, then process each bookmark.`;
    
    const args = [
      'run',
      '--format', 'json',
      '--model', ocConfig.model,
      prompt
    ];

    // Log the command for debugging
    console.log(`\n  🔧 Running: ${opencodePath} ${args.slice(0, 4).join(' ')} "<prompt>"\n`);

    // Ensure PATH includes common node locations
    const nodePaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      process.env.NVM_BIN,
      path.join(process.env.HOME || '', '.local/bin'),
      path.join(process.env.HOME || '', '.bun/bin'),
    ].filter(Boolean);
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
      reasoning: 0,
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
      // Show stderr in real-time for debugging
      if (text.trim()) {
        process.stderr.write(`  [stderr] ${text}`);
      }
    });

    const timeoutId = setTimeout(() => {
      stopSpinner();
      proc.kill('SIGTERM');
      console.error(`\n  ❌ OpenCode timed out after ${timeout / 1000}s`);
      resolve({
        success: false,
        error: `Timeout after ${timeout}ms`,
        stdout,
        stderr,
        exitCode: -1,
        duration: Date.now() - startTime
      });
    }, timeout);

    proc.on('close', (code) => {
      stopSpinner();
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ success: true, output: stdout, tokenUsage });
      } else {
        console.error(`\n  ❌ OpenCode exited with code ${code}`);
        if (stderr.trim()) {
          console.error(`  📋 stderr:\n${stderr.split('\n').map(l => '     ' + l).join('\n')}`);
        }
        if (stdout.trim() && stdout.length < 2000) {
          console.error(`  📋 stdout (last 2000 chars):\n${stdout.slice(-2000).split('\n').map(l => '     ' + l).join('\n')}`);
        }
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
      console.error(`\n  ❌ Failed to spawn OpenCode: ${err.message}`);
      resolve({
        success: false,
        error: err.message,
        stdout,
        stderr,
        exitCode: -1,
        duration: Date.now() - startTime
      });
    });
  });
}

async function sendWebhook(config, payload) {
  if (!config.webhookUrl) return;

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`Webhook error: ${error.message}`);
  }
}

function formatDiscordPayload(title, description, success = true) {
  return {
    embeds: [{
      title,
      description,
      color: success ? 0x00ff00 : 0xff0000,
      timestamp: new Date().toISOString()
    }]
  };
}

function formatSlackPayload(title, description, success = true) {
  return {
    text: title,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${success ? '✅' : '❌'} ${title}` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: description }
      }
    ]
  };
}

async function notify(config, title, description, success = true) {
  if (!config.webhookUrl) return;

  let payload;
  if (config.webhookType === 'slack') {
    payload = formatSlackPayload(title, description, success);
  } else {
    // Default to Discord format
    payload = formatDiscordPayload(title, description, success);
  }

  await sendWebhook(config, payload);
}

// ============================================================================
// Main Job Runner
// ============================================================================

export async function run(options = {}) {
  const startTime = Date.now();
  const now = new Date().toISOString();
  const config = loadConfig(options.configPath);

  console.log(`[${now}] Starting smaug job...`);

  // Overlap protection
  if (!acquireLock()) {
    return { success: true, skipped: true };
  }

  try {
    // Check for existing pending bookmarks first
    let pendingData = null;
    let bookmarkCount = 0;

    if (fs.existsSync(config.pendingFile)) {
      try {
        pendingData = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
        bookmarkCount = pendingData.bookmarks?.length || 0;

        // Apply --limit if specified (process subset of pending)
        const limit = options.limit;
        if (limit && limit > 0 && bookmarkCount > limit) {
          console.log(`[${now}] Limiting to ${limit} of ${bookmarkCount} pending bookmarks`);
          pendingData.bookmarks = pendingData.bookmarks.slice(0, limit);
          bookmarkCount = limit;
          // Write limited subset back (temporarily)
          fs.writeFileSync(config.pendingFile + '.full', JSON.stringify(
            JSON.parse(fs.readFileSync(config.pendingFile, 'utf8')), null, 2
          ));
          pendingData.count = bookmarkCount;
          fs.writeFileSync(config.pendingFile, JSON.stringify(pendingData, null, 2));
        }
      } catch (e) {
        // Invalid pending file, will fetch fresh
      }
    }

    // Phase 1: Fetch new bookmarks (merges with existing pending)
    if (bookmarkCount === 0 || options.forceFetch) {
      console.log(`[${now}] Phase 1: Fetching and preparing bookmarks...`);
      const prepResult = await fetchAndPrepareBookmarks(options);

      // Re-read pending file after fetch
      if (fs.existsSync(config.pendingFile)) {
        pendingData = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
        bookmarkCount = pendingData.bookmarks?.length || 0;
      }

      if (prepResult.count > 0) {
        console.log(`[${now}] Fetched ${prepResult.count} new bookmarks`);
      }
    } else {
      console.log(`[${now}] Found ${bookmarkCount} pending bookmarks, skipping fetch`);
    }

    if (bookmarkCount === 0) {
      console.log(`[${now}] No bookmarks to process`);
      return { success: true, count: 0, duration: Date.now() - startTime };
    }

    console.log(`[${now}] Processing ${bookmarkCount} bookmarks`);

    // Track IDs we're about to process
    const idsToProcess = pendingData.bookmarks.map(b => b.id);

    // Backup bookmarks.md before processing
    backupBookmarks(config);

    // Phase 2: AI analysis (if enabled)
    const provider = getAIProvider(config);
    const providerName = provider === 'opencode' ? 'OpenCode' : 'Claude Code';

    if (config.autoInvokeClaude !== false) {
      console.log(`[${now}] Phase 2: Invoking ${providerName} for analysis...`);

      const aiResult = await invokeAIProvider(config, bookmarkCount, {
        trackTokens: options.trackTokens
      });

      if (aiResult.success) {
        console.log(`[${now}] Analysis complete`);

        // Remove processed IDs from pending file
        // If --limit was used, we need to restore from .full backup (which has ALL bookmarks)
        // and filter out only the processed ones, then write back to pending-file
        const fullFile = config.pendingFile + '.full';
        const usedLimit = options.limit && options.limit > 0;

        let sourceData;
        try {
          if (fs.existsSync(fullFile)) {
            // Always read from .full if it exists (contains full backup)
            sourceData = JSON.parse(fs.readFileSync(fullFile, 'utf8'));
            fs.unlinkSync(fullFile); // Clean up backup
          } else if (fs.existsSync(config.pendingFile)) {
            const content = fs.readFileSync(config.pendingFile, 'utf8');
            const trimmed = content.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
              sourceData = JSON.parse(content);
            } else {
              console.warn(`[${now}] Warning: pending file appears corrupted, using empty state`);
              sourceData = { bookmarks: [], generatedAt: new Date().toISOString() };
            }
          }
        } catch (parseError) {
          console.warn(`[${now}] Warning: failed to parse pending file: ${parseError.message}`);
          sourceData = { bookmarks: [], generatedAt: new Date().toISOString() };
        }

        if (sourceData) {
          const processedIds = new Set(idsToProcess);
          const remaining = sourceData.bookmarks.filter(b => !processedIds.has(b.id));

          fs.writeFileSync(config.pendingFile, JSON.stringify({
            generatedAt: sourceData.generatedAt,
            count: remaining.length,
            bookmarks: remaining
          }, null, 2));

          console.log(`[${now}] Cleaned up ${idsToProcess.length} processed bookmarks, ${remaining.length} remaining`);
        }

        // Send success notification
        await notify(
          config,
          'Bookmarks Processed',
          `**New:** ${bookmarkCount} bookmarks archived`,
          true
        );

        return {
          success: true,
          count: bookmarkCount,
          duration: Date.now() - startTime,
          output: aiResult.output,
          tokenUsage: aiResult.tokenUsage
        };

      } else {
        // AI failed
        const isTimeout = aiResult.error?.includes('Timeout') || aiResult.error?.includes('timeout');
        const fullFile = config.pendingFile + '.full';

        if (isTimeout) {
          // On timeout: Restore from .full backup first, THEN calculate remaining
          // The pending file currently only has the limited subset
          if (fs.existsSync(fullFile)) {
            fs.copyFileSync(fullFile, config.pendingFile);
            fs.unlinkSync(fullFile);
          }

          console.error(`\n⚠️  ${providerName} TIMEOUT after ${Math.round((aiResult.duration || 0) / 60000)} minutes`);
          console.error(`   The pending file has been restored from backup.`);
          console.error(`   Try running with a smaller batch size to avoid timeouts.\n`);

          // Count remaining bookmarks (now from restored full file)
          let remainingCount = 0;
          try {
            const pending = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
            remainingCount = pending.bookmarks?.length || 0;
          } catch (e) {}

          if (remainingCount > 0) {
            console.error(`   ${remainingCount} bookmarks remaining in pending file.\n`);
          }

          await notify(
            config,
            'Bookmark Processing Timed Out',
            `${providerName} timed out after ${Math.round(aiResult.duration / 60000)} minutes. ${remainingCount} bookmarks remain pending. Try a smaller batch size.`,
            false
          );

          return {
            success: false,
            count: 0,
            duration: Date.now() - startTime,
            error: aiResult.error,
            timedOut: true,
            remainingBookmarks: remainingCount
          };

        } else {
          // Non-timeout failure - restore from .full for retry
          if (fs.existsSync(fullFile)) {
            fs.copyFileSync(fullFile, config.pendingFile);
            fs.unlinkSync(fullFile);
            console.log(`[${now}] Restored full pending file for retry`);
          }

          console.error(`[${now}] ${providerName} failed:`, aiResult.error);

          await notify(
            config,
            'Bookmark Processing Failed',
            `Prepared ${bookmarkCount} bookmarks but analysis failed:\n${aiResult.error}`,
            false
          );

          return {
            success: false,
            count: bookmarkCount,
            duration: Date.now() - startTime,
            error: aiResult.error
          };
        }
      }
    } else {
      // Auto-invoke disabled - just fetch
      console.log(`[${now}] AI auto-invoke disabled. Run 'smaug process' or /process-bookmarks manually.`);

      return {
        success: true,
        count: bookmarkCount,
        duration: Date.now() - startTime,
        pendingFile: config.pendingFile
      };
    }

  } catch (error) {
    console.error(`[${now}] Job error:`, error.message);

    await notify(
      config,
      'Smaug Job Failed',
      `Error: ${error.message}`,
      false
    );

    return {
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    };
  } finally {
    releaseLock();
  }
}

// ============================================================================
// Reprocess function - creates missing knowledge files
// ============================================================================

async function reprocess(options = {}) {
  const startTime = Date.now();
  const now = new Date().toLocaleTimeString();
  
  if (!acquireLock()) {
    return { success: false, error: 'Another job is running' };
  }

  try {
    const config = loadConfig();
    const reprocessFile = options.reprocessFile;
    
    if (!fs.existsSync(reprocessFile)) {
      console.error(`[${now}] Reprocess file not found: ${reprocessFile}`);
      return { success: false, error: 'Reprocess file not found' };
    }
    
    const data = JSON.parse(fs.readFileSync(reprocessFile, 'utf8'));
    const count = data.count;
    
    // Backup bookmarks.md before processing
    backupBookmarks(config);
    
    console.log(`[${now}] Creating knowledge files for ${count} bookmarks...`);
    
    const provider = getAIProvider(config);
    
    if (provider === 'opencode') {
      const result = await invokeOpenCodeReprocess(config, count, reprocessFile, options);
      return {
        success: result.success,
        count,
        duration: Date.now() - startTime,
        error: result.error
      };
    } else {
      // Claude Code reprocess
      const result = await invokeClaudeCodeReprocess(config, count, reprocessFile, options);
      return {
        success: result.success,
        count,
        duration: Date.now() - startTime,
        error: result.error
      };
    }
  } catch (error) {
    console.error(`[${now}] Reprocess error:`, error.message);
    return {
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    };
  } finally {
    releaseLock();
  }
}

async function invokeOpenCodeReprocess(config, count, reprocessFile, options = {}) {
  const ocConfig = getOpenCodeConfig(config);
  const timeout = config.claudeTimeout || 900000;

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
  if (opencodePath === 'opencode') {
    try {
      opencodePath = execSync('which opencode', { encoding: 'utf8' }).trim() || 'opencode';
    } catch {
      // which failed, stick with 'opencode'
    }
  }

  console.log(`
   🐉 SMAUG Reprocess Mode
   Creating ${count} knowledge files...
`);

  const prompt = `Create knowledge files for the ${count} bookmark(s) in ${reprocessFile}.

Read the JSON file first. For each entry:
1. Read the link URL
2. If it's a GitHub repo (github.com/user/repo), create ./knowledge/tools/{repo-name}.md
3. If it's an article (medium, substack, dev.to), create ./knowledge/articles/{slug}.md

Use these templates:

## Tool (./knowledge/tools/{slug}.md):
---
title: "{repo_name}"
type: tool
date_added: ${new Date().toISOString().split('T')[0]}
source: "{github_url}"
via: "Twitter bookmark from @{author}"
---
{Description based on the tweet text and repo}
## Links
- [GitHub]({github_url})
- [Original Tweet]({tweet_url})

## Article (./knowledge/articles/{slug}.md):
---
title: "{article_title}"
type: article
date_added: ${new Date().toISOString().split('T')[0]}
source: "{article_url}"
via: "Twitter bookmark from @{author}"
---
{Summary based on the tweet text}
## Links
- [Article]({article_url})
- [Original Tweet]({tweet_url})

After creating each knowledge file, update bookmarks.md to add "- **Filed:** [filename](path)" line to that entry.

DO NOT commit or push - these files are in .gitignore.

Process all ${count} entries.`;

  return new Promise((resolve) => {
    const args = [
      'run',
      '--model', ocConfig.model,
      prompt
    ];

    const proc = spawn(opencodePath, args, {
      cwd: config.projectRoot || process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        TERM: process.env.TERM || 'xterm-256color',
      },
      stdio: 'inherit',
    });

    // Timeout handling
    const timeoutId = setTimeout(() => {
      console.log(`\n\n   ⏰ Timeout reached after ${Math.round(timeout / 60000)} minutes`);
      proc.kill('SIGTERM');
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      console.log(`\n   ✓ Reprocess complete`);
      resolve({ success: code === 0 });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      console.error(`\n   ❌ OpenCode error: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

async function invokeClaudeCodeReprocess(config, count, reprocessFile, options = {}) {
  const claudeConfig = getClaudeCodeConfig(config);
  
  const prompt = `Create knowledge files for the ${count} bookmark(s) in ${reprocessFile}. Follow the instructions in ./.claude/commands/process-bookmarks.md for templates. Create the knowledge files and update bookmarks.md to add Filed: lines. DO NOT commit or push - these files are in .gitignore.`;
  
  return new Promise((resolve) => {
    const args = ['--dangerously-skip-permissions', '-p', prompt];
    
    if (claudeConfig.model) {
      args.push('--model', claudeConfig.model);
    }
    
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env }
    });
    
    child.on('close', (code) => {
      resolve({ success: code === 0, error: code !== 0 ? `Claude exited with code ${code}` : null });
    });
    
    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

// ============================================================================
// Bree-compatible export
// ============================================================================

export default {
  name: JOB_NAME,
  interval: '*/30 * * * *', // Every 30 minutes
  timezone: 'America/New_York',
  run,
  reprocess,
  // Reprocess state management exports
  loadReprocessState,
  saveReprocessState,
  syncReprocessState,
  getEntriesToProcess,
  markEntriesInProgress,
  verifyAndUpdateState,
  formatReprocessStatus
};

// ============================================================================
// Direct execution
// ============================================================================

if (process.argv[1] && process.argv[1].endsWith('job.js')) {
  run().then(result => {
    // Exit silently - the dragon output is enough
    process.exit(result.success ? 0 : 1);
  });
}
