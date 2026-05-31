#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const checks = [
  {
    name: 'Windows user profile path',
    pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g
  },
  {
    name: 'WSL personal home path',
    pattern: new RegExp('/home/' + 'martin\\b', 'gi')
  },
  {
    name: 'private workspace folder',
    pattern: new RegExp('Documents[/\\\\]New project', 'gi')
  },
  {
    name: 'private business ideas source file',
    pattern: new RegExp('business_' + 'ideas_67', 'gi')
  },
  {
    name: 'private OpenClaw source pack file',
    pattern: new RegExp('openclaw_' + '250_source_pack', 'gi')
  },
  {
    name: 'OpenClaw quarantine path',
    pattern: /openclaw-simple-\d{4}-\d{2}-\d{2}T/gi
  },
  {
    name: 'GitHub token shape',
    pattern: /gh[opsru]_[A-Za-z0-9_]{20,}/g
  },
  {
    name: 'OpenAI token shape',
    pattern: /sk-[A-Za-z0-9_-]{20,}/g
  },
  {
    name: 'explicit OpenAI API key assignment',
    pattern: /OPENAI_API_KEY\s*=/g
  },
  {
    name: 'Bearer credential',
    pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/gi
  }
];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function isProbablyBinary(buffer) {
  return buffer.includes(0);
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function main() {
  const findings = [];
  for (const file of trackedFiles()) {
    const buffer = fs.readFileSync(file);
    if (isProbablyBinary(buffer)) continue;
    const text = buffer.toString('utf8');
    for (const check of checks) {
      check.pattern.lastIndex = 0;
      for (const match of text.matchAll(check.pattern)) {
        findings.push({
          file,
          line: lineNumber(text, match.index || 0),
          check: check.name
        });
      }
    }
  }

  if (findings.length) {
    console.error('privacy-audit failed: tracked files contain potential private data');
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} ${finding.check}`);
    }
    process.exit(1);
  }

  console.log('privacy-audit-ok');
}

main();
