/**
 * diff-formatter.js — Unified diff utility using the 'diff' package.
 */

import { createTwoFilesPatch } from 'diff';

/**
 * Produce a unified diff string from two file contents.
 * @param {string} filePath — The file path to show in the header
 * @param {string|null} oldContent — Original content (null = new file)
 * @param {string|null} newContent — Modified content (null = deleted file)
 * @returns {string} Unified diff output
 */
export function formatUnifiedDiff(filePath, oldContent, newContent) {
  const oldStr = oldContent ?? '';
  const newStr = newContent ?? '';

  if (oldContent === null) {
    // New file
    return createTwoFilesPatch('/dev/null', `b/${filePath}`, '', newStr, '', '', { context: 3 });
  }

  if (newContent === null) {
    // Deleted file
    return createTwoFilesPatch(`a/${filePath}`, '/dev/null', oldStr, '', '', '', { context: 3 });
  }

  return createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, oldStr, newStr, '', '', { context: 3 });
}

/**
 * Check if content is likely binary.
 */
export function isBinary(content) {
  if (content === null || content === undefined) return false;
  // Check for null bytes in the first 8KB
  const sample = content.slice(0, 8192);
  return sample.includes('\0');
}
