import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Get commits per file in the last 90 days
 */
export async function getChangeFrequency() {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const since = ninetyDaysAgo.toISOString().split('T')[0];

  let output = '';
  await exec.exec('git', ['log', '--since', since, '--name-only', '--pretty=format:'], {
    listeners: {
      stdout: (data) => { output += data.toString(); }
    },
    silent: true
  });

  const fileCounts = {};
  const lines = output.split('\n').filter(line => line.trim());
  for (const file of lines) {
    const trimmed = file.trim();
    if (trimmed) {
      fileCounts[trimmed] = (fileCounts[trimmed] || 0) + 1;
    }
  }
  return fileCounts;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count how many other files import/require/from a given file
 * Supports: JS/TS (import/require/from), Python (import/from X import), Ruby (require), Go (import)
 */
export async function getReferenceCount(targetFile) {
  const basename = path.basename(targetFile).replace(/\.[^/.]+$/, '');
  const escapedBasename = escapeRegex(basename);

  // Multi-language pattern:
  // - JS/TS: import X from 'Y', require('Y'), from 'Y'
  // - Python: import X, from X import Y
  // - Ruby: require 'X', require_relative 'X'
  // - Go: import "X"
  const pattern = `(import|require|require_relative|from).*['"].*${escapedBasename}['"]|^import\\s+${escapedBasename}|^from\\s+${escapedBasename}\\s+import`;

  let output = '';
  try {
    await exec.exec('git', ['grep', '-l', '-E', pattern], {
      listeners: {
        stdout: (data) => { output += data.toString(); }
      },
      silent: true,
      ignoreReturnCode: true
    });
  } catch {
    return 0;
  }

  const files = output.split('\n').filter(line => {
    const trimmed = line.trim();
    return trimmed &&
           (trimmed.endsWith('.js') || trimmed.endsWith('.ts') || trimmed.endsWith('.py') ||
            trimmed.endsWith('.jsx') || trimmed.endsWith('.tsx') ||
            trimmed.endsWith('.rb') || trimmed.endsWith('.go')) &&
           trimmed !== targetFile;
  });

  return files.length;
}

/**
 * Get all source files in the repo (capped at 500 most recently modified)
 */
export async function getAllSourceFiles() {
  let output = '';
  await exec.exec('git', ['ls-files', '*.js', '*.ts', '*.jsx', '*.tsx', '*.py', '*.rb', '*.go'], {
    listeners: {
      stdout: (data) => { output += data.toString(); }
    },
    silent: true,
    ignoreReturnCode: true
  });

  let files = output.split('\n').filter(line => line.trim());

  // Cap at 500 files to prevent memory blowup on large repos
  const MAX_FILES = 500;
  if (files.length > MAX_FILES) {
    core.warning(`Large repo: analyzing most recent ${MAX_FILES} files (found ${files.length})`);

    // Get modification times and sort by most recent
    const fileStats = [];
    for (const file of files) {
      let mtime = '';
      try {
        await exec.exec('git', ['log', '-1', '--format=%ct', '--', file], {
          listeners: {
            stdout: (data) => { mtime += data.toString(); }
          },
          silent: true,
          ignoreReturnCode: true
        });
        fileStats.push({ file, mtime: parseInt(mtime.trim(), 10) || 0 });
      } catch {
        fileStats.push({ file, mtime: 0 });
      }
    }

    fileStats.sort((a, b) => b.mtime - a.mtime);
    files = fileStats.slice(0, MAX_FILES).map(f => f.file);
  }

  return files;
}

/**
 * Parse lcov.info coverage file
 */
export function parseLcovCoverage(coveragePath) {
  if (!coveragePath || !fs.existsSync(coveragePath)) {
    return null;
  }

  // Security: Validate coverage path is within current working directory
  const cwd = process.cwd();
  const resolvedPath = path.resolve(coveragePath);
  if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
    core.warning(`coverage_path must be within the repository: ${coveragePath}`);
    return null;
  }

  const content = fs.readFileSync(coveragePath, 'utf8');

  if (coveragePath.endsWith('.json')) {
    try {
      const json = JSON.parse(content);
      const coverage = {};
      // Jest coverage-summary.json format has "total" plus per-file entries
      for (const [filePath, data] of Object.entries(json)) {
        // Skip the "total" summary entry
        if (filePath === 'total') {
          continue;
        }
        if (data && data.lines && typeof data.lines.pct === 'number') {
          coverage[filePath] = data.lines.pct;
        }
      }
      return Object.keys(coverage).length > 0 ? coverage : null;
    } catch {
      return null;
    }
  }

  const coverage = {};
  let currentFile = null;
  let linesFound = 0;
  let linesHit = 0;

  for (const line of content.split('\n')) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3);
      linesFound = 0;
      linesHit = 0;
    } else if (line.startsWith('LF:')) {
      linesFound = parseInt(line.slice(3), 10);
    } else if (line.startsWith('LH:')) {
      linesHit = parseInt(line.slice(3), 10);
    } else if (line === 'end_of_record' && currentFile) {
      coverage[currentFile] = linesFound > 0 ? (linesHit / linesFound) * 100 : 0;
      currentFile = null;
    }
  }

  return coverage;
}

/**
 * Calculate risk score
 */
export function calculateRiskScore(changeCount, referenceCount, coveragePct) {
  const coverageGap = coveragePct !== null ? (100 - coveragePct) : 50;
  return (changeCount * 0.4) + (referenceCount * 0.4) + (coverageGap * 0.2);
}

/**
 * Get emoji based on risk score
 */
export function getEmoji(score) {
  if (score >= 80) return '🔴';
  if (score >= 60) return '🟠';
  return '🟡';
}

/**
 * Validate license key for private repos
 */
export async function validateLicense(licenseKey, githubUsername, repo) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch('https://api.difflog.io/validate-fragile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: licenseKey,
        github_username: githubUsername,
        repo: repo
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await response.json();
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    core.warning(`License validation error: ${error.message}. Continuing anyway.`);
    return { valid: true, error: true };
  }
}

/**
 * Get AI explanation for a fragile file (with 30s timeout per call)
 */
export async function getAIExplanation(openai, filePath, referenceCount, changeCount, coveragePct) {
  const TIMEOUT_MS = 30000;

  try {
    const coverageStr = coveragePct !== null ? `${coveragePct.toFixed(0)}%` : 'unknown';

    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS);
    });

    const apiPromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `This file "${filePath}" is flagged as high-risk in a codebase. It has ${referenceCount} files that depend on it, has been changed ${changeCount} times in the last 90 days, and has ${coverageStr} test coverage. In 2-3 sentences, explain why this file is load-bearing and what could break if it fails or has bugs. Be specific and practical.`
      }],
      max_tokens: 150
    });

    const response = await Promise.race([apiPromise, timeoutPromise]);

    // Defensive check for empty or malformed response
    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      core.warning(`OpenAI returned empty response for ${filePath}`);
      return 'Unable to generate explanation. This file has high change frequency and many dependents, making it a critical point of failure.';
    }
    return content.trim();
  } catch (error) {
    if (error.message === 'TIMEOUT') {
      core.warning(`OpenAI API timeout for ${filePath}`);
      return '[Analysis timed out — check your OpenAI API key has available credits]';
    }
    core.warning(`OpenAI API error for ${filePath}: ${error.message}`);
    return 'Unable to generate explanation. This file has high change frequency and many dependents, making it a critical point of failure.';
  }
}

/**
 * Generate FRAGILE.md content
 */
export function generateFragileMd(files, date) {
  let content = `# FRAGILE.md
> Generated by [Fragile](https://usefragile.dev) — ${date}

These files are load-bearing. Change them carefully.

`;

  if (files.length === 0) {
    content += `No fragile files detected in this codebase. Either the codebase is well-structured, or there isn't enough git history to analyze.\n`;
    return content;
  }

  for (const file of files) {
    const emoji = getEmoji(file.score);
    const coverageStr = file.coveragePct !== null ? `${file.coveragePct.toFixed(0)}%` : 'N/A';

    content += `## ${emoji} ${file.path}
**Risk score: ${file.score.toFixed(0)}** · ${file.referenceCount} dependents · changed ${file.changeCount} times in 90 days · ${coverageStr} test coverage

${file.explanation}

---

`;
  }

  return content;
}

/**
 * Check if the repository appears to be a shallow clone
 */
export async function checkShallowClone() {
  let commitCount = 0;
  let output = '';

  try {
    await exec.exec('git', ['rev-list', '--count', 'HEAD'], {
      listeners: {
        stdout: (data) => { output += data.toString(); }
      },
      silent: true
    });
    commitCount = parseInt(output.trim(), 10) || 0;
  } catch {
    return; // Can't determine, skip warning
  }

  // Check if shallow by looking for .git/shallow file
  let isShallow = false;
  try {
    let shallowOutput = '';
    await exec.exec('git', ['rev-parse', '--is-shallow-repository'], {
      listeners: {
        stdout: (data) => { shallowOutput += data.toString(); }
      },
      silent: true
    });
    isShallow = shallowOutput.trim() === 'true';
  } catch {
    // Fallback: if we have very few commits, it might be shallow
    isShallow = commitCount <= 2;
  }

  if (isShallow && commitCount <= 2) {
    core.warning(
      "Shallow clone detected (fetch-depth not 0). Fragile needs full git history for accurate analysis. " +
      "Add 'fetch-depth: 0' to your checkout step."
    );
  }
}

/**
 * Main entry point
 */
export async function run() {
  try {
    // Check for shallow clone first (the #1 user error)
    await checkShallowClone();

    const openaiKey = core.getInput('openai_key', { required: true });
    const licenseKey = core.getInput('license_key');
    const topN = parseInt(core.getInput('top_n') || '10', 10);
    let minReferences = parseInt(core.getInput('min_references') || '3', 10);
    const coveragePath = core.getInput('coverage_path');

    // min_references must be at least 1
    if (minReferences < 1) {
      minReferences = 1;
    }

    if (!openaiKey) {
      core.setFailed('openai_key is required');
      return;
    }

    if (topN === 0) {
      core.info('top_n is 0, skipping analysis');
      return;
    }

    const context = github.context;
    const isPrivate = context.payload?.repository?.private ?? false;

    if (isPrivate) {
      core.info('Private repository detected, validating license...');
      const owner = context.repo?.owner || context.payload?.repository?.owner?.login || '';
      const repo = context.repo?.repo || context.payload?.repository?.name || '';

      const result = await validateLicense(licenseKey, owner, `${owner}/${repo}`);

      if (!result.error && result.valid === false) {
        core.warning('Invalid Fragile license key. Get one at usefragile.dev');
        process.exit(0);
      }
    }

    core.info('Analyzing repository for fragile files...');

    const openai = new OpenAI({ apiKey: openaiKey, timeout: 30000 });
    const changeCounts = await getChangeFrequency();
    const allFiles = await getAllSourceFiles();
    const coverage = parseLcovCoverage(coveragePath);

    core.info(`Found ${allFiles.length} source files to analyze`);

    const fileScores = [];

    for (const file of allFiles) {
      const changeCount = changeCounts[file] || 0;
      const referenceCount = await getReferenceCount(file);

      if (referenceCount < minReferences) {
        continue;
      }

      let coveragePct = null;
      if (coverage) {
        const normalizedPath = file.startsWith('/') ? file : file;
        for (const [covPath, pct] of Object.entries(coverage)) {
          if (covPath.endsWith(file) || file.endsWith(covPath) || covPath.includes(file)) {
            coveragePct = pct;
            break;
          }
        }
      }

      const score = calculateRiskScore(changeCount, referenceCount, coveragePct);

      fileScores.push({
        path: file,
        changeCount,
        referenceCount,
        coveragePct,
        score
      });
    }

    fileScores.sort((a, b) => b.score - a.score);
    const topFiles = fileScores.slice(0, topN);

    core.info(`Found ${topFiles.length} fragile files above threshold`);

    for (const file of topFiles) {
      file.explanation = await getAIExplanation(
        openai,
        file.path,
        file.referenceCount,
        file.changeCount,
        file.coveragePct
      );
    }

    const date = new Date().toISOString().split('T')[0];
    const fragileContent = generateFragileMd(topFiles, date);

    fs.writeFileSync('FRAGILE.md', fragileContent);
    core.info('Generated FRAGILE.md');

    await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
    await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
    await exec.exec('git', ['add', 'FRAGILE.md']);

    let hasChanges = false;
    try {
      await exec.exec('git', ['diff', '--cached', '--quiet']);
    } catch {
      hasChanges = true;
    }

    if (hasChanges) {
      await exec.exec('git', ['commit', '-m', 'chore: update FRAGILE.md']);
      await exec.exec('git', ['push']);
      core.info('Committed and pushed FRAGILE.md');
    } else {
      core.info('No changes to FRAGILE.md');
    }

    core.setOutput('fragile_count', topFiles.length);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();

