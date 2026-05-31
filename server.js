#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const APP_ROOT = process.env.OPENCLAW_WEB_UI_ROOT || __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_DIR = process.env.OPENCLAW_WEB_UI_DATA_DIR || path.join(APP_ROOT, 'data');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const HOME = process.env.HOME || os.homedir();
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || path.join(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_HOME = path.dirname(CONFIG_PATH);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const MOCK = process.env.OPENCLAW_WEB_UI_MOCK === '1';
const DEFAULT_HOST = process.env.OPENCLAW_WEB_UI_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.OPENCLAW_WEB_UI_PORT || 8787);
const MAX_BODY_BYTES = 1024 * 1024;
const PRIORITY_SCORE = { urgent: 4, high: 3, normal: 2, low: 1 };
const TASK_COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'];
const RUNNABLE_COLUMNS = new Set(['backlog', 'todo']);
const SWARM_LANES = ['backlog', 'ready', 'running', 'review', 'blocked', 'done'];
const SWARM_PLAYBOOKS = {
  build: {
    id: 'build',
    label: 'Build or Fix',
    description: 'Research the issue, implement the change, then verify it with evidence.',
    defaultWorkers: ['researcher', 'coder', 'verifier'],
    roleBriefs: {
      Research: 'Find the relevant docs, prior local notes, and risks before implementation starts.',
      Builder: 'Implement the smallest useful local change and run focused checks.',
      Reviewer: 'Verify the change, capture failures first, and report whether it is ready.'
    }
  },
  research: {
    id: 'research',
    label: 'Research Brief',
    description: 'Gather sources, compare claims, analyze tradeoffs, and produce a checked answer.',
    defaultWorkers: ['researcher', 'analyzer', 'verifier'],
    roleBriefs: {
      Research: 'Collect source-backed facts and include concrete dates when recency matters.',
      Analyzer: 'Turn the source material into decisions, risks, assumptions, and next actions.',
      Reviewer: 'Check source quality, contradictions, and citation coverage.'
    }
  },
  finance: {
    id: 'finance',
    label: 'Finance Study',
    description: 'Use the university/finance specialist with data and source support.',
    defaultWorkers: ['school', 'analyzer', 'researcher', 'verifier'],
    roleBriefs: {
      Study: 'Explain the finance or university problem step by step with assumptions and formulas.',
      Analyzer: 'Check calculations, data, spreadsheet logic, and interpretation risk.',
      Research: 'Find reputable source context if the task needs external material.',
      Reviewer: 'Verify formulas, units, signs, timing, and citation quality.'
    }
  },
  ops: {
    id: 'ops',
    label: 'Ops Check',
    description: 'Inspect local runtime state, isolate blockers, and propose safe operational steps.',
    defaultWorkers: ['operator', 'verifier', 'coder'],
    roleBriefs: {
      Ops: 'Inspect services, logs, queues, and safe recovery paths without broad cleanup.',
      Reviewer: 'Validate health checks, reproduction evidence, and residual risk.',
      Builder: 'Patch local scripts or UI code only if the operational issue points to code.'
    }
  },
  audit: {
    id: 'audit',
    label: 'Audit and Improve',
    description: 'Review a system, find weak spots, and turn findings into practical fixes.',
    defaultWorkers: ['analyzer', 'verifier', 'coder'],
    roleBriefs: {
      Analyzer: 'Rank findings by impact and separate evidence from inference.',
      Reviewer: 'Reproduce the risky behavior and identify missing checks.',
      Builder: 'Prepare focused fixes for confirmed issues.'
    }
  }
};
const MEMORY_FILE_EXTENSIONS = new Set(['.md', '.json', '.jsonl', '.txt']);

let queueRunning = false;

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(': connected\n\n');
}

function sseWrite(res, event, payload) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeAgentId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function safeSessionId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id);
}

function safeRelativeFilePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 500
    && !value.includes('\0')
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes('..');
}

function safeTaskId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id);
}

function defaultWorkspace(config) {
  return config?.agents?.defaults?.workspace || path.join(OPENCLAW_HOME, 'workspace');
}

function defaultModel(config) {
  const model = config?.agents?.defaults?.model;
  if (typeof model === 'string') return model;
  if (typeof model?.primary === 'string') return model.primary;
  const models = config?.agents?.defaults?.models;
  if (Array.isArray(models) && typeof models[0] === 'string') return models[0];
  if (models && typeof models === 'object') {
    const first = Object.keys(models)[0];
    if (first) return first;
  }
  return '';
}

async function exists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath, maxChars = 60000) {
  try {
    const value = await fsp.readFile(filePath, 'utf8');
    return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
  } catch {
    return '';
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, filePath);
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function mockConfig() {
  const workspace = path.join(DATA_DIR, 'mock-openclaw', 'workspace');
  const agentDir = path.join(DATA_DIR, 'mock-openclaw', 'agents');
  return {
    agents: {
      defaults: {
        workspace,
        model: { primary: 'mock/openclaw' },
        skills: [],
        thinkingDefault: 'medium',
        fastModeDefault: false
      },
      list: [
        {
          id: 'main',
          name: 'main',
          workspace,
          agentDir: path.join(agentDir, 'main'),
          identity: { name: 'Atlas', theme: 'orchestration' },
          tools: { profile: 'coding' }
        },
        {
          id: 'coder',
          name: 'coder',
          workspace: path.join(workspace, 'agents', 'coder'),
          agentDir: path.join(agentDir, 'coder'),
          identity: { name: 'Forge', theme: 'implementation' },
          tools: { profile: 'coding' }
        }
      ]
    }
  };
}

async function readConfig() {
  try {
    return await readJson(CONFIG_PATH);
  } catch (err) {
    if (MOCK && err.code === 'ENOENT') return mockConfig();
    throw err;
  }
}

function parseIdentity(markdown) {
  const name = markdown.match(/\*\*Name:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  const vibe = markdown.match(/\*\*Vibe:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  const role = markdown.match(/\*\*Role:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  const emoji = markdown.match(/\*\*Emoji:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  return { name, vibe, role, emoji };
}

async function loadAgentFileSet(agent) {
  const workspace = agent.workspace;
  const allowedRoot = defaultWorkspace(await readConfig());
  if (!workspace || !isInside(path.resolve(workspace), path.resolve(allowedRoot))) {
    return { identityText: '', personality: '', instructions: '', toolsText: '', userText: '' };
  }
  return {
    identityText: await readTextIfExists(path.join(workspace, 'IDENTITY.md')),
    personality: await readTextIfExists(path.join(workspace, 'SOUL.md')),
    instructions: await readTextIfExists(path.join(workspace, 'AGENTS.md')),
    toolsText: await readTextIfExists(path.join(workspace, 'TOOLS.md')),
    userText: await readTextIfExists(path.join(workspace, 'USER.md'))
  };
}

async function getAgents() {
  const config = await readConfig();
  const baseWorkspace = defaultWorkspace(config);
  const configured = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const entries = configured.some((agent) => agent.id === 'main')
    ? configured
    : [{ id: 'main' }, ...configured];
  const modelDefault = defaultModel(config);

  return Promise.all(entries.map(async (entry) => {
    const workspace = entry.workspace || baseWorkspace;
    const files = await loadAgentFileSet({ workspace });
    const parsedIdentity = parseIdentity(files.identityText);
    const identity = {
      name: entry.identity?.name || parsedIdentity.name || (entry.id === 'main' ? 'Atlas' : entry.name || entry.id),
      emoji: entry.identity?.emoji || parsedIdentity.emoji || '',
      theme: entry.identity?.theme || parsedIdentity.role || ''
    };
    return {
      id: entry.id,
      name: entry.name || entry.id,
      identity,
      workspace,
      agentDir: entry.agentDir || path.join(OPENCLAW_HOME, 'agents', entry.id),
      model: entry.model || modelDefault,
      thinkingDefault: entry.thinkingDefault || config?.agents?.defaults?.thinkingDefault || '',
      fastModeDefault: typeof entry.fastModeDefault === 'boolean'
        ? entry.fastModeDefault
        : Boolean(config?.agents?.defaults?.fastModeDefault),
      skills: entry.skills || config?.agents?.defaults?.skills || [],
      tools: entry.tools || {},
      isDefault: entry.id === 'main',
      personality: files.personality,
      instructions: files.instructions,
      toolsText: files.toolsText,
      identityText: files.identityText
    };
  }));
}

async function validateAgentId(id) {
  if (!safeAgentId(id)) throw httpError(400, 'Invalid agent id.');
  const agents = await getAgents();
  const agent = agents.find((item) => item.id === id);
  if (!agent) throw httpError(404, 'Unknown agent.');
  return agent;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseJsonFromOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error(`Command did not return JSON: ${trimmed.slice(0, 240)}`);
  }
}

async function runOpenClaw(args, options = {}) {
  if (MOCK) return mockOpenClaw(args);
  return new Promise((resolve, reject) => {
    execFile(OPENCLAW_BIN, args, {
      cwd: defaultWorkspaceFromDisk(),
      timeout: options.timeoutMs || 660000,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
      env: { ...process.env }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultWorkspaceFromDisk() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return defaultWorkspace(config);
  } catch {
    return path.join(OPENCLAW_HOME, 'workspace');
  }
}

async function mockOpenClaw(args) {
  if (args[0] === 'agent') {
    const agent = args[args.indexOf('--agent') + 1] || 'main';
    const message = args[args.indexOf('--message') + 1] || '';
    return {
      stdout: JSON.stringify({
        runId: `mock-${crypto.randomUUID()}`,
        status: 'ok',
        result: {
          payloads: [{ text: `[${agent}] ${message}`, mediaUrl: null }],
          meta: { durationMs: 1 }
        }
      })
    };
  }
  if (args[0] === 'config' && args[1] === 'validate') {
    return { stdout: 'Config valid\n' };
  }
  return { stdout: '{}' };
}

function extractAgentText(result) {
  const payloads = result?.result?.payloads;
  if (Array.isArray(payloads) && payloads.length) {
    return payloads.map((payload) => payload.text || '').filter(Boolean).join('\n').trim();
  }
  return result?.result?.meta?.finalAssistantVisibleText
    || result?.result?.finalAssistantVisibleText
    || result?.summary
    || '';
}

function compactAgentRaw(result) {
  const meta = result?.result?.meta || {};
  const agentMeta = meta.agentMeta || {};
  return {
    runId: result?.runId || '',
    status: result?.status || '',
    summary: result?.summary || '',
    result: {
      payloads: result?.result?.payloads || [],
      meta: {
        durationMs: meta.durationMs,
        aborted: meta.aborted,
        provider: agentMeta.provider,
        model: agentMeta.model,
        sessionId: agentMeta.sessionId,
        usage: agentMeta.usage,
        stopReason: meta.stopReason || meta.completion?.stopReason
      }
    }
  };
}

function chatArgs(agentId, message, sessionId) {
  const args = ['agent', '--agent', agentId, '--message', message.trim(), '--json', '--timeout', '600'];
  if (sessionId) args.splice(3, 0, '--session-id', sessionId);
  return args;
}

async function sendChat(agentId, message, sessionId) {
  await validateAgentId(agentId);
  if (typeof message !== 'string' || !message.trim()) throw httpError(400, 'Message is required.');
  if (message.length > 24000) throw httpError(400, 'Message is too long.');
  if (sessionId && !safeSessionId(sessionId)) throw httpError(400, 'Invalid session id.');
  const args = chatArgs(agentId, message, sessionId);
  const { stdout } = await runOpenClaw(args, { timeoutMs: 660000 });
  const result = parseJsonFromOutput(stdout);
  return {
    runId: result.runId || '',
    status: result.status || 'ok',
    text: extractAgentText(result),
    raw: result
  };
}

async function streamChat(req, res, input) {
  const agentId = input.agentId || 'main';
  const message = String(input.message || '');
  const sessionId = input.sessionId || `web-${crypto.randomUUID()}`;
  await validateAgentId(agentId);
  if (!message.trim()) throw httpError(400, 'Message is required.');
  if (message.length > 24000) throw httpError(400, 'Message is too long.');
  if (!safeSessionId(sessionId)) throw httpError(400, 'Invalid session id.');

  sseStart(res);
  sseWrite(res, 'status', { status: 'starting', sessionId, text: 'Starting agent run' });

  if (MOCK) {
    sseWrite(res, 'activity', { kind: 'reasoning', label: 'Thinking', text: 'Mock stream initialized.' });
    sseWrite(res, 'activity', { kind: 'tool', label: 'mock_tool', text: 'Mock tool event emitted.' });
    const result = await sendChat(agentId, message, sessionId);
    sseWrite(res, 'final', result);
    sseWrite(res, 'done', { ok: true });
    res.end();
    return;
  }

  const args = chatArgs(agentId, message, sessionId);
  const child = spawn(OPENCLAW_BIN, args, {
    cwd: defaultWorkspaceFromDisk(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let logOffset = 0;
  let logRemainder = '';
  let finished = false;
  const sent = new Set();
  const logPath = path.join(sessionDirForAgent(agentId), `${sessionId}.jsonl`);

  const emitActivity = (activity) => {
    if (!activity?.text) return;
    const key = `${activity.kind}:${activity.label}:${activity.text}`;
    if (sent.has(key)) return;
    sent.add(key);
    sseWrite(res, 'activity', activity);
  };

  const pumpLog = async () => {
    try {
      const buffer = await fsp.readFile(logPath);
      if (buffer.length < logOffset) {
        logOffset = 0;
        logRemainder = '';
      }
      if (buffer.length === logOffset) return;
      const chunk = buffer.slice(logOffset).toString('utf8');
      logOffset = buffer.length;
      const lines = `${logRemainder}${chunk}`.split(/\r?\n/);
      logRemainder = lines.pop() || '';
      lines.forEach((line) => {
        if (!line.trim()) return;
        const formatted = formatSessionLine(line);
        streamActivitiesFromMessage(formatted).forEach(emitActivity);
      });
    } catch (err) {
      if (err.code !== 'ENOENT') emitActivity({ kind: 'error', label: 'Log stream', text: err.message || String(err) });
    }
  };

  const poll = setInterval(() => {
    pumpLog().catch((err) => emitActivity({ kind: 'error', label: 'Log stream', text: err.message || String(err) }));
  }, 350);

  const stop = () => {
    clearInterval(poll);
    if (!child.killed) child.kill('SIGTERM');
  };
  res.on('close', () => {
    if (!res.writableEnded) stop();
  });

  child.stdout.on('data', (chunk) => {
    const textChunk = chunk.toString('utf8');
    stdout += textChunk;
    textChunk.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const parsed = JSON.parse(trimmed);
        const formatted = formatSessionLine(JSON.stringify(parsed));
        streamActivitiesFromMessage(formatted).forEach(emitActivity);
      } catch {
        // Final pretty JSON is parsed after process exit.
      }
    });
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    sseWrite(res, 'error', { error: err.message || String(err) });
    sseWrite(res, 'done', { ok: false });
    res.end();
  });
  child.on('close', async (code) => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    await pumpLog();
    if (code !== 0) {
      const error = stderr.trim() || stdout.trim() || `OpenClaw exited with code ${code}`;
      sseWrite(res, 'error', { error: error.slice(0, 4000), sessionId });
      sseWrite(res, 'done', { ok: false });
      res.end();
      return;
    }
    try {
      const result = parseJsonFromOutput(stdout);
      sseWrite(res, 'final', {
        runId: result.runId || '',
        status: result.status || 'ok',
        text: extractAgentText(result),
        raw: compactAgentRaw(result),
        sessionId
      });
      sseWrite(res, 'done', { ok: true, sessionId });
    } catch (err) {
      sseWrite(res, 'error', { error: err.message || String(err), sessionId });
      sseWrite(res, 'done', { ok: false, sessionId });
    }
    res.end();
  });
}

function sessionDirForAgent(agentId) {
  return path.join(OPENCLAW_HOME, 'agents', agentId, 'sessions');
}

function cronRunDir() {
  return path.join(OPENCLAW_HOME, 'cron', 'runs');
}

function isSessionTranscriptFile(name) {
  return typeof name === 'string'
    && name.endsWith('.jsonl')
    && !name.endsWith('.trajectory.jsonl')
    && !name.includes('.checkpoint.');
}

function sessionKindFromKey(key) {
  if (key.includes(':subagent:')) return 'subagent';
  if (key.includes(':cron:')) return 'cron';
  return 'direct';
}

function sessionFromStoreEntry(dir, key, value) {
  const sessionId = value.sessionId || key.split(':').pop();
  const startedAt = value.sessionStartedAt
    || value.startedAt
    || value.createdAt
    || value.updatedAt
    || value.lastInteractionAt
    || null;
  return {
    key,
    sessionId,
    startedAt,
    updatedAt: value.updatedAt || value.lastInteractionAt || value.sessionStartedAt || null,
    model: value.model || value.modelOverride || '',
    provider: value.modelProvider || value.providerOverride || '',
    totalTokens: value.totalTokens || null,
    kind: sessionKindFromKey(key),
    registered: true,
    logSource: 'missing',
    fileExists: false
  };
}

async function sessionLogPathIfExists(agentId, sessionId) {
  if (!safeSessionId(sessionId)) return null;
  const dir = path.resolve(sessionDirForAgent(agentId));
  const sessionPath = path.resolve(path.join(dir, `${sessionId}.jsonl`));
  if (isInside(sessionPath, dir) && await exists(sessionPath)) {
    return { filePath: sessionPath, source: 'agent-session' };
  }

  const cronRoot = path.resolve(cronRunDir());
  const cronPath = path.resolve(path.join(cronRoot, `${sessionId}.jsonl`));
  if (isInside(cronPath, cronRoot) && await exists(cronPath)) {
    return { filePath: cronPath, source: 'cron-run' };
  }

  return null;
}

async function readSessionLogHead(filePath, maxBytes = 65536) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function inferSessionFromLogFile(dir, fileName) {
  const sessionId = fileName.slice(0, -'.jsonl'.length);
  if (!safeSessionId(sessionId)) return null;
  const filePath = path.join(dir, fileName);
  const stat = await fsp.stat(filePath);
  const summary = {
    key: `log:${sessionId}`,
    sessionId,
    startedAt: stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs,
    updatedAt: stat.mtimeMs,
    model: '',
    provider: '',
    totalTokens: null,
    kind: 'direct',
    registered: false,
    logSource: 'agent-session',
    fileExists: true
  };

  try {
    const head = await readSessionLogHead(filePath);
    const lines = head.split(/\r?\n/).filter(Boolean).slice(0, 80);
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = toMillis(parsed.timestamp || parsed.at || parsed.createdAt || parsed.time);
      if (timestamp && (!summary.startedAt || timestamp < summary.startedAt)) summary.startedAt = timestamp;
      if (parsed.type === 'model_change') {
        summary.provider ||= parsed.provider || '';
        summary.model ||= parsed.modelId || parsed.model || '';
      }
      if (parsed.type === 'custom' && parsed.customType === 'model-snapshot') {
        summary.provider ||= parsed.data?.provider || '';
        summary.model ||= parsed.data?.modelId || parsed.data?.modelApi || '';
      }
      const message = parsed.message || {};
      summary.provider ||= message.modelProvider || message.provider || '';
      summary.model ||= message.model || message.modelId || '';
      summary.totalTokens ||= message.usage?.totalTokens || parsed.usage?.totalTokens || null;
    }
  } catch {
    // File stats are still enough for the session index.
  }

  return summary;
}

async function listSessions(agentId) {
  await validateAgentId(agentId);
  const dir = sessionDirForAgent(agentId);
  const storePath = path.join(dir, 'sessions.json');
  const store = await readJson(storePath, {});
  const sessions = await Promise.all(Object.entries(store).map(async ([key, value]) => {
    const session = sessionFromStoreEntry(dir, key, value);
    const found = await sessionLogPathIfExists(agentId, session.sessionId);
    session.fileExists = Boolean(found);
    session.logSource = found?.source || 'missing';
    return session;
  }));
  const knownIds = new Set(sessions.map((session) => session.sessionId));

  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const fileName of files.filter(isSessionTranscriptFile)) {
    const sessionId = fileName.slice(0, -'.jsonl'.length);
    if (knownIds.has(sessionId)) continue;
    const inferred = await inferSessionFromLogFile(dir, fileName);
    if (inferred) sessions.push(inferred);
  }

  return sessions
    .filter((session) => session.fileExists)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function listAllSessions() {
  const agents = await getAgents();
  const groups = await Promise.all(agents.map(async (agent) => ({
    agentId: agent.id,
    agentName: agent.identity?.name || agent.name || agent.id,
    sessions: await listSessions(agent.id)
  })));
  return groups;
}

async function allSessionsFlat() {
  const groups = await listAllSessions();
  return groups.flatMap((group) => group.sessions.map((session) => ({
    ...session,
    agentId: group.agentId,
    agentName: group.agentName
  }))).sort((a, b) => (b.startedAt || b.updatedAt || 0) - (a.startedAt || a.updatedAt || 0));
}

async function exportAgentSessions(agentId) {
  const sessions = await listSessions(agentId);
  const exported = [];
  for (const session of sessions) {
    if (!session.fileExists) continue;
    const filePath = await sessionLogPath(agentId, session.sessionId);
    exported.push({
      ...session,
      log: await fsp.readFile(filePath, 'utf8')
    });
  }
  return {
    agentId,
    exportedAt: nowIso(),
    sessions: exported
  };
}

async function sessionLogPath(agentId, sessionId) {
  await validateAgentId(agentId);
  if (!safeSessionId(sessionId)) throw httpError(400, 'Invalid session id.');
  const found = await sessionLogPathIfExists(agentId, sessionId);
  if (!found) throw httpError(404, 'Session log not found.');
  return found.filePath;
}

async function loadSessionPreview(agentId, sessionId) {
  const filePath = await sessionLogPath(agentId, sessionId);
  const content = await fsp.readFile(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  return {
    sessionId,
    lines: lines.slice(-80),
    messages: lines.slice(-120).map(formatSessionLine).filter(Boolean),
    sizeBytes: Buffer.byteLength(content)
  };
}

function roleLabel(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'user' || value === 'me' || value === 'input') return 'You';
  if (value === 'assistant' || value === 'agent' || value === 'output') return 'Agent';
  if (value.includes('tool')) return 'Tool';
  if (value.includes('reason')) return 'Reasoning';
  if (value.includes('system')) return 'System';
  return role || 'Event';
}

const STREAM_ACTIVITY_TEXT_LIMIT = 120000;

function cleanLogText(value) {
  return String(value || '')
    .replace(/\n?<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\n?/g, '')
    .replace(/\n?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\n?/g, '')
    .replace(/^\s*Source: Web Search\s*\n---\s*\n/gm, '')
    .trim();
}

function limitActivityText(value, max = STREAM_ACTIVITY_TEXT_LIMIT) {
  const text = cleanLogText(value);
  if (text.length <= max) return { text, clipped: false };
  return {
    text: `${text.slice(0, max)}\n\n[Output clipped in the live stream after ${max.toLocaleString()} characters.]`,
    clipped: true
  };
}

function prettyJson(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function contentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n\n').trim();
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.thinking === 'string') return value.thinking.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (Array.isArray(value.content)) return contentText(value.content);
    if (typeof value.message === 'string') return value.message.trim();
    if (typeof value.summary === 'string') return value.summary.trim();
    if (Array.isArray(value.summary)) return contentText(value.summary);
    if (typeof value.output === 'string') return value.output.trim();
    if (typeof value.result === 'string') return value.result.trim();
  }
  return '';
}

function toolCallText(item) {
  const name = item?.name || item?.toolName || 'tool';
  const args = item?.arguments ?? item?.input ?? {};
  const body = prettyJson(args).trim();
  return [`Tool call: ${name}`, body ? 'Arguments:' : '', body].filter(Boolean).join('\n');
}

function formatOpenClawMessage(parsed) {
  const message = parsed.message || {};
  const role = String(message.role || parsed.role || 'message');
  const at = parsed.at || parsed.createdAt || parsed.timestamp || parsed.time || message.timestamp || '';
  const content = Array.isArray(message.content) ? message.content : [message.content].filter(Boolean);

  if (role.toLowerCase() === 'toolresult') {
    const limited = limitActivityText(contentText(content) || contentText(message.details));
    return {
      role: 'tool',
      label: message.toolName || 'Tool result',
      at,
      text: limited.text,
      format: 'code',
      clipped: limited.clipped,
      raw: parsed
    };
  }

  if (role.toLowerCase() === 'assistant') {
    const textParts = [];
    const events = [];
    for (const item of content) {
      const type = String(item?.type || '').toLowerCase();
      if (type === 'text') {
        const text = contentText(item);
        if (text) textParts.push(cleanLogText(text));
        continue;
      }
      if (type === 'thinking' || type === 'reasoning') {
        const limited = limitActivityText(contentText(item), 24000);
        if (limited.text) {
          events.push({
            kind: 'reasoning',
            label: 'Thinking',
            text: limited.text,
            format: 'markdown',
            at,
            clipped: limited.clipped
          });
        }
        continue;
      }
      if (type === 'toolcall' || type === 'tool_call' || item?.toolName || item?.name) {
        const limited = limitActivityText(toolCallText(item), 40000);
        if (limited.text) {
          events.push({
            kind: 'tool',
            label: item?.name || item?.toolName || 'Tool call',
            text: limited.text,
            format: 'code',
            at,
            clipped: limited.clipped
          });
        }
      }
    }
    const text = textParts.filter(Boolean).join('\n\n').trim();
    if (!text && !events.length) return null;
    return {
      role,
      label: roleLabel(role),
      at,
      text,
      events,
      raw: parsed
    };
  }

  const text = contentText(content) || contentText(message);
  if (!text) return null;
  return {
    role,
    label: roleLabel(role),
    at,
    text: cleanLogText(text),
    raw: parsed
  };
}

function activityFormatForText(kind, text) {
  const value = String(text || '').trim();
  if (kind === 'tool') return 'code';
  if (/^(\{|\[)[\s\S]*(\}|\])$/.test(value)) return 'code';
  if (/```/.test(value)) return 'markdown';
  if (value.split('\n').length > 6 && /[{}()[\];=<>]/.test(value)) return 'code';
  return 'markdown';
}

function streamActivitiesFromMessage(message) {
  if (!message) return [];
  const sourceItems = Array.isArray(message.events) && message.events.length ? message.events : [message];
  return sourceItems.flatMap((item) => {
    const role = String(item?.role || item?.kind || '').toLowerCase();
    if (!item?.text || role === 'user' || role === 'me' || role === 'input') return [];
    let kind = item.kind || 'status';
    if (!item.kind) {
      if (role.includes('reason') || role.includes('thinking') || role.includes('thought')) kind = 'reasoning';
      else if (role.includes('tool') || role.includes('function') || role.includes('command')) kind = 'tool';
      else if (role.includes('assistant') || role.includes('agent') || role.includes('output')) kind = 'assistant';
      else if (role.includes('error') || role.includes('fail')) kind = 'error';
    }
    const limited = limitActivityText(item.text, item.format === 'code' || kind === 'tool' ? STREAM_ACTIVITY_TEXT_LIMIT : 32000);
    if (!limited.text) return [];
    return [{
      kind,
      label: item.label || roleLabel(role || kind),
      text: limited.text,
      at: item.at || message.at || '',
      format: item.format || activityFormatForText(kind, limited.text),
      clipped: item.clipped || limited.clipped
    }];
  });
}

function streamActivityFromMessage(message) {
  return streamActivitiesFromMessage(message)[0] || null;
}

function formatSessionLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type === 'session') {
      return {
        role: 'system',
        label: 'Session',
        at: parsed.timestamp || parsed.time || '',
        text: `Started in ${parsed.cwd || 'workspace'}`,
        raw: parsed
      };
    }
    if (parsed.type === 'model_change') {
      return {
        role: 'system',
        label: 'Model',
        at: parsed.timestamp || '',
        text: `${parsed.provider || 'provider'} · ${parsed.modelId || parsed.model || 'model'}`,
        raw: parsed
      };
    }
    if (parsed.type === 'thinking_level_change') {
      return {
        role: 'reasoning',
        label: 'Thinking',
        at: parsed.timestamp || '',
        text: `Thinking level: ${parsed.thinkingLevel || 'inherited'}`,
        raw: parsed
      };
    }
    if (parsed.type === 'custom' && parsed.customType === 'model-snapshot') {
      return {
        role: 'system',
        label: 'Model Snapshot',
        at: parsed.timestamp || parsed.data?.timestamp || '',
        text: `${parsed.data?.provider || 'provider'} · ${parsed.data?.modelId || parsed.data?.modelApi || 'model'}`,
        raw: parsed
      };
    }
    if (parsed.jobId && parsed.action) {
      return {
        role: 'system',
        label: 'Cron',
        at: parsed.ts ? new Date(parsed.ts).toISOString() : '',
        text: [parsed.action, parsed.status, parsed.summary].filter(Boolean).join(' · '),
        raw: parsed
      };
    }
    if (parsed.message) return formatOpenClawMessage(parsed);
    const role = parsed.message?.role || parsed.role || parsed.type || parsed.event || parsed.kind || 'event';
    const textValue = parsed.text
      || extractReadableText(parsed.message)
      || extractReadableText(parsed.content)
      || extractReadableText(parsed.delta)
      || extractReadableText(parsed.result)
      || parsed.summary
      || parsed.title
      || '';
    const text = String(textValue || '').trim();
    if (!text) return null;
    return {
      role: String(role),
      label: roleLabel(role),
      at: parsed.at || parsed.createdAt || parsed.timestamp || parsed.time || '',
      text,
      raw: parsed
    };
  } catch {
    return line.trim() ? { role: 'raw', label: 'Log', at: '', text: line.trim(), raw: null } : null;
  }
}

async function searchSessionLogs(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { query, results: [] };
  const sessions = await allSessionsFlat();
  const results = [];
  for (const session of sessions) {
    if (!session.fileExists) continue;
    const filePath = await sessionLogPath(session.agentId, session.sessionId);
    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const matches = [];
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(q)) {
        matches.push({ line: index + 1, text: readableJsonlLine(line).slice(0, 360) });
      }
    });
    if (matches.length) {
      results.push({
        agentId: session.agentId,
        agentName: session.agentName,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        kind: session.kind,
        matches: matches.slice(0, 8),
        count: matches.length
      });
    }
  }
  return { query, results };
}

async function loadTasks() {
  const data = await readJson(TASKS_PATH, { settings: { mode: 'priority', autoRun: false }, tasks: [] });
  data.settings ||= { mode: 'priority', autoRun: false };
  data.tasks ||= [];
  data.tasks = data.tasks.map(migrateTask);
  return data;
}

async function saveTasks(data) {
  await writeJsonAtomic(TASKS_PATH, data);
}

function normalizePriority(priority) {
  return Object.hasOwn(PRIORITY_SCORE, priority) ? priority : 'normal';
}

function normalizeColumn(column) {
  return TASK_COLUMNS.includes(column) ? column : 'backlog';
}

function normalizeMode(mode) {
  return mode === 'time' ? 'time' : 'priority';
}

function statusFromColumn(column) {
  if (column === 'in_progress') return 'running';
  if (column === 'done') return 'done';
  if (column === 'blocked') return 'failed';
  return 'pending';
}

function columnFromStatus(status) {
  if (status === 'running') return 'in_progress';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'blocked';
  return 'todo';
}

function migrateTask(task) {
  const column = normalizeColumn(task.column || columnFromStatus(task.status));
  return {
    assignee: 'main',
    position: 0,
    acceptanceCriteria: [],
    reviewer: '',
    missionId: '',
    missionTitle: '',
    createdBy: 'atlas',
    ...task,
    priority: normalizePriority(task.priority),
    column,
    status: task.status && ['pending', 'running', 'done', 'failed'].includes(task.status)
      ? task.status
      : statusFromColumn(column),
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : [],
    reviewer: safeAgentId(task.reviewer) ? task.reviewer : '',
    missionId: safeTaskId(task.missionId) ? task.missionId : '',
    missionTitle: String(task.missionTitle || '').slice(0, 200),
    createdBy: String(task.createdBy || 'atlas').slice(0, 80),
    createdAt: task.createdAt || nowIso(),
    updatedAt: task.updatedAt || task.createdAt || nowIso(),
    result: task.result || '',
    runId: task.runId || '',
    error: task.error || ''
  };
}

function dueTime(task) {
  if (!task.dueAt) return task.createdAt || '';
  return task.dueAt;
}

function isDue(task, at = new Date()) {
  if (!task.dueAt) return true;
  const due = new Date(task.dueAt);
  return Number.isNaN(due.getTime()) ? true : due <= at;
}

function selectNextTask(tasks, mode = 'priority') {
  const candidates = tasks
    .map(migrateTask)
    .filter((task) => task.status === 'pending' && RUNNABLE_COLUMNS.has(task.column) && isDue(task));
  candidates.sort((a, b) => {
    if (mode === 'time') {
      return String(dueTime(a)).localeCompare(String(dueTime(b)))
        || (PRIORITY_SCORE[b.priority] || 0) - (PRIORITY_SCORE[a.priority] || 0)
        || String(a.createdAt).localeCompare(String(b.createdAt));
    }
    return (PRIORITY_SCORE[b.priority] || 0) - (PRIORITY_SCORE[a.priority] || 0)
      || String(dueTime(a)).localeCompare(String(dueTime(b)))
      || String(a.createdAt).localeCompare(String(b.createdAt));
  });
  return candidates[0] || null;
}

async function addTask(input) {
  const title = String(input.title || '').trim();
  if (!title) throw httpError(400, 'Task title is required.');
  const data = await loadTasks();
  const task = {
    id: crypto.randomUUID(),
    title: title.slice(0, 200),
    details: String(input.details || '').slice(0, 12000),
    priority: normalizePriority(input.priority),
    column: normalizeColumn(input.column || 'backlog'),
    assignee: safeAgentId(input.assignee) ? input.assignee : 'main',
    reviewer: safeAgentId(input.reviewer) ? input.reviewer : '',
    missionId: safeTaskId(input.missionId) ? input.missionId : '',
    missionTitle: String(input.missionTitle || '').slice(0, 200),
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria)
      ? input.acceptanceCriteria.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : [],
    createdBy: String(input.createdBy || 'atlas').slice(0, 80),
    position: Number.isFinite(Number(input.position)) ? Number(input.position) : Date.now(),
    dueAt: input.dueAt ? String(input.dueAt) : '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    result: '',
    runId: '',
    error: ''
  };
  task.status = statusFromColumn(task.column);
  data.tasks.unshift(task);
  await saveTasks(data);
  return task;
}

async function patchTask(id, patch) {
  const data = await loadTasks();
  const task = data.tasks.find((item) => item.id === id);
  if (!task) throw httpError(404, 'Task not found.');
  for (const field of ['title', 'details', 'dueAt']) {
    if (field in patch) task[field] = String(patch[field] || '');
  }
  if ('priority' in patch) task.priority = normalizePriority(patch.priority);
  if ('assignee' in patch) task.assignee = String(patch.assignee || 'main').slice(0, 80);
  if ('reviewer' in patch) task.reviewer = safeAgentId(patch.reviewer) ? patch.reviewer : '';
  if ('missionId' in patch) task.missionId = safeTaskId(patch.missionId) ? patch.missionId : '';
  if ('acceptanceCriteria' in patch) {
    task.acceptanceCriteria = Array.isArray(patch.acceptanceCriteria)
      ? patch.acceptanceCriteria.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
      : [];
  }
  if ('position' in patch && Number.isFinite(Number(patch.position))) task.position = Number(patch.position);
  if ('column' in patch) {
    task.column = normalizeColumn(patch.column);
    task.status = statusFromColumn(task.column);
  }
  if ('status' in patch && ['pending', 'running', 'done', 'failed'].includes(patch.status)) task.status = patch.status;
  if ('status' in patch && !('column' in patch)) task.column = columnFromStatus(task.status);
  task.updatedAt = nowIso();
  await saveTasks(data);
  return task;
}

async function deleteTask(id) {
  const data = await loadTasks();
  const before = data.tasks.length;
  data.tasks = data.tasks.filter((task) => task.id !== id);
  if (data.tasks.length === before) throw httpError(404, 'Task not found.');
  await saveTasks(data);
  return { ok: true };
}

function atlasTaskPrompt(task) {
  const assignee = task.assignee && task.assignee !== 'main' ? task.assignee : 'Atlas';
  return [
    `Task board item for ${assignee}.`,
    'Handle this task according to the maintainer priorities and existing OpenClaw safety rules.',
    'Do not send messages, post publicly, make purchases, trade, submit forms, or act externally unless the task contains exact explicit approval for that outward action.',
    '',
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
    `Due: ${task.dueAt || 'now'}`,
    '',
    'Details:',
    task.details || '(none)',
    '',
    'Finish with a concise status and any follow-up needed.'
  ].join('\n');
}

async function runTaskById(id) {
  let task;
  let data = await loadTasks();
  task = data.tasks.find((item) => item.id === id);
  if (!task) throw httpError(404, 'Task not found.');
  if (task.status === 'running') return task;
  task.status = 'running';
  task.column = 'in_progress';
  task.startedAt = nowIso();
  task.updatedAt = nowIso();
  task.error = '';
  await saveTasks(data);

  try {
    const targetAgent = safeAgentId(task.assignee) ? task.assignee : 'main';
    const result = await sendChat(targetAgent, atlasTaskPrompt(task));
    data = await loadTasks();
    task = data.tasks.find((item) => item.id === id);
    task.status = 'done';
    task.column = 'done';
    task.result = result.text || '(no text result)';
    task.runId = result.runId || '';
    task.endedAt = nowIso();
    task.updatedAt = nowIso();
    await saveTasks(data);
    return task;
  } catch (err) {
    data = await loadTasks();
    task = data.tasks.find((item) => item.id === id);
    task.status = 'failed';
    task.column = 'blocked';
    task.error = err.message || String(err);
    task.endedAt = nowIso();
    task.updatedAt = nowIso();
    await saveTasks(data);
    return task;
  }
}

async function runQueue() {
  if (queueRunning) return { ok: true, running: true };
  queueRunning = true;
  try {
    const data = await loadTasks();
    const next = selectNextTask(data.tasks, normalizeMode(data.settings.mode));
    if (!next) return { ok: true, ran: false };
    const task = await runTaskById(next.id);
    return { ok: true, ran: true, task };
  } finally {
    queueRunning = false;
  }
}

async function updateTaskSettings(input) {
  const data = await loadTasks();
  data.settings.mode = normalizeMode(input.mode);
  data.settings.autoRun = Boolean(input.autoRun);
  await saveTasks(data);
  return data.settings;
}

async function dashboardSummary() {
  const [agents, taskData, sessionGroups] = await Promise.all([
    getAgents(),
    loadTasks(),
    listAllSessions()
  ]);
  const tasks = taskData.tasks.map(migrateTask);
  const sessions = sessionGroups.flatMap((group) => group.sessions.map((session) => ({ ...session, agentId: group.agentId })));
  const byColumn = Object.fromEntries(TASK_COLUMNS.map((column) => [
    column,
    tasks.filter((task) => task.column === column).length
  ]));
  return {
    generatedAt: nowIso(),
    agents: {
      total: agents.length,
      defaultAgent: agents.find((agent) => agent.isDefault)?.id || 'main',
      ids: agents.map((agent) => agent.id)
    },
    tasks: {
      total: tasks.length,
      runnable: tasks.filter((task) => task.status === 'pending' && RUNNABLE_COLUMNS.has(task.column)).length,
      running: tasks.filter((task) => task.status === 'running').length,
      done: tasks.filter((task) => task.status === 'done').length,
      blocked: tasks.filter((task) => task.column === 'blocked').length,
      overdue: tasks.filter((task) => isDue(task) && task.dueAt && task.status !== 'done').length,
      byColumn
    },
    sessions: {
      total: sessions.length,
      downloadable: sessions.filter((session) => session.fileExists).length,
      recent: sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6)
    }
  };
}

function modelProvider(model) {
  const value = String(model || '').trim();
  if (!value) return 'unknown';
  if (value.includes('/')) return value.split('/')[0];
  if (/gpt|openai/i.test(value)) return 'openai-codex';
  if (/claude|anthropic/i.test(value)) return 'anthropic';
  return 'custom';
}

function agentRole(agent) {
  const text = [
    agent.identity?.theme,
    agent.name,
    agent.id
  ].filter(Boolean).join(' ').toLowerCase();
  if (agent.id === 'coder' || /code|build|implement|forge/.test(text)) return 'Builder';
  if (agent.id === 'researcher' || /research|source|scout/.test(text)) return 'Research';
  if (agent.id === 'analyzer' || /analysis|analy/.test(text)) return 'Analyzer';
  if (agent.id === 'verifier' || /verify|review|qa|test/.test(text)) return 'Reviewer';
  if (agent.id === 'operator' || /operat|ops|terminal/.test(text)) return 'Ops';
  if (agent.id === 'school' || /school|study|finance|university/.test(text)) return 'Study';
  return agent.isDefault ? 'Orchestrator' : 'Worker';
}

function agentMission(agent) {
  const role = agentRole(agent);
  const missions = {
    Orchestrator: 'Route work, keep state, decide who should handle each lane, and ask for human confirmation before outward-facing actions.',
    Builder: 'Implement local changes, run checks, and report proof-bearing status.',
    Research: 'Gather current information, cite sources, and turn uncertainty into concrete briefs.',
    Analyzer: 'Break down risks, compare options, and surface weak assumptions.',
    Reviewer: 'Verify diffs, tests, and readiness before work is accepted.',
    Ops: 'Handle local automation, runtime checks, and operational cleanup.',
    Study: 'Support university finance work with structured explanations, practice, and source-backed research.',
    Worker: 'Take focused delegated tasks and report concise checkpoints.'
  };
  return missions[role] || missions.Worker;
}

function normalizePlaybookId(value, goal = '') {
  const id = String(value || '').trim().toLowerCase();
  if (SWARM_PLAYBOOKS[id]) return id;
  const text = String(goal || '').toLowerCase();
  if (/(finance|valuation|accounting|university|exam|study|spreadsheet|excel|discount|cash flow|portfolio)/.test(text)) return 'finance';
  if (/(research|source|compare|latest|market|news|paper|reddit|docs)/.test(text)) return 'research';
  if (/(server|gateway|cron|health|service|runtime|log|wsl|ops|restart)/.test(text)) return 'ops';
  if (/(audit|review|risk|regression|verify|quality|improve)/.test(text)) return 'audit';
  return 'build';
}

function swarmPlaybook(value, goal = '') {
  return SWARM_PLAYBOOKS[normalizePlaybookId(value, goal)] || SWARM_PLAYBOOKS.build;
}

function roleBrief(agent, playbook) {
  const role = agentRole(agent);
  return playbook.roleBriefs?.[role]
    || playbook.roleBriefs?.Worker
    || 'Handle the focused lane and report a proof-bearing checkpoint.';
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function swarmLaneFromTask(task) {
  const column = normalizeColumn(task.column || columnFromStatus(task.status));
  if (column === 'todo') return 'ready';
  if (column === 'in_progress') return 'running';
  return column;
}

function columnFromSwarmLane(lane) {
  if (lane === 'ready') return 'todo';
  if (lane === 'running') return 'in_progress';
  return TASK_COLUMNS.includes(lane) ? lane : 'backlog';
}

function checkpointStatus(task) {
  const lane = swarmLaneFromTask(task);
  if (lane === 'done') return 'done';
  if (lane === 'blocked') return 'blocked';
  if (lane === 'review') return 'needs_review';
  if (lane === 'running') return 'running';
  return 'queued';
}

function taskToSwarmCard(task) {
  const migrated = migrateTask(task);
  return {
    id: migrated.id,
    title: migrated.title,
    spec: migrated.details || '',
    acceptanceCriteria: migrated.acceptanceCriteria || [],
    assignedWorker: migrated.assignee || null,
    reviewer: migrated.reviewer || null,
    status: swarmLaneFromTask(migrated),
    missionId: migrated.missionId || null,
    missionTitle: migrated.missionTitle || '',
    priority: migrated.priority || 'normal',
    result: migrated.result || '',
    error: migrated.error || '',
    reportPath: null,
    createdBy: migrated.createdBy || 'atlas',
    createdAt: toMillis(migrated.createdAt) || Date.now(),
    updatedAt: toMillis(migrated.updatedAt) || Date.now()
  };
}

async function latestSessionTail(agentId, sessions, maxLines = 6) {
  const latest = sessions.find((session) => session.fileExists);
  if (!latest) return { latest: sessions[0] || null, tail: '', logPath: null };
  const filePath = await sessionLogPath(agentId, latest.sessionId);
  const content = await fsp.readFile(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean).map(readableJsonlLine).filter(Boolean).slice(-maxLines);
  return { latest, tail: lines.join('\n'), logPath: filePath };
}

function readableJsonlLine(line) {
  try {
    const parsed = JSON.parse(line);
    const role = parsed.role || parsed.type || parsed.event || 'event';
    const direct = parsed.text || parsed.content || parsed.message;
    if (typeof direct === 'string' && direct.trim()) return `${role}: ${direct.trim()}`;
    const nested = extractReadableText(parsed.message) || extractReadableText(parsed.content);
    if (nested) return `${role}: ${nested}`;
    const payloads = parsed.result?.payloads;
    if (Array.isArray(payloads)) {
      const textValue = payloads.map((payload) => payload?.text || '').filter(Boolean).join(' ').trim();
      if (textValue) return `${role}: ${textValue}`;
    }
    const output = parsed.result?.meta?.finalAssistantVisibleText || parsed.summary || parsed.title;
    if (typeof output === 'string' && output.trim()) return `${role}: ${output.trim()}`;
    return `${role}: ${JSON.stringify(parsed).slice(0, 180)}`;
  } catch {
    return line.slice(0, 220);
  }
}

function extractReadableText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(extractReadableText).filter(Boolean).join(' ').trim();
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (Array.isArray(value.content)) return value.content.map(extractReadableText).filter(Boolean).join(' ').trim();
    if (typeof value.message === 'string') return value.message.trim();
  }
  return '';
}

async function listAvailableSkills() {
  const [agents, config] = await Promise.all([getAgents(), readConfig()]);
  const workspace = path.resolve(defaultWorkspace(config));
  const skillsRoot = path.join(workspace, 'skills');
  const used = new Set();
  for (const agent of agents) {
    for (const skill of agent.skills || []) used.add(String(skill).trim());
  }
  const entries = [];
  try {
    const names = await fsp.readdir(skillsRoot);
    for (const name of names) {
      const dir = path.join(skillsRoot, name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!(await exists(skillFile))) continue;
      const summary = (await readTextIfExists(skillFile, 1600)).split('\n').find((line) => line.trim() && !line.startsWith('#')) || '';
      entries.push({
        id: name,
        name,
        installed: true,
        used: used.has(name),
        summary: summary.trim().slice(0, 180)
      });
    }
  } catch {
    // Missing skills directory is acceptable.
  }
  for (const name of used) {
    if (name && !entries.some((entry) => entry.id === name)) {
      entries.push({ id: name, name, installed: false, used: true, summary: 'Configured on at least one agent.' });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { skills: entries, used: [...used].sort() };
}

function isMemoryRelatedRelative(rel) {
  const normalized = rel.split(path.sep).join('/');
  if (/^(MEMORY|DREAMS|HEARTBEAT|USER|AGENTS|TOOLS|SOUL|IDENTITY)\.md$/.test(normalized)) return true;
  if (normalized.startsWith('memory/')) return true;
  if (normalized.startsWith('.learnings/')) return true;
  if (/^agents\/[^/]+\/(MEMORY|DREAMS|HEARTBEAT|USER|AGENTS|TOOLS|SOUL|IDENTITY)\.md$/.test(normalized)) return true;
  if (/^agents\/[^/]+\/memory\//.test(normalized)) return true;
  return false;
}

async function addRootMemoryFiles(workspace, out) {
  for (const name of ['MEMORY.md', 'DREAMS.md', 'HEARTBEAT.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'SOUL.md', 'IDENTITY.md']) {
    const target = path.join(workspace, name);
    if (!(await exists(target))) continue;
    const stat = await fsp.stat(target);
    out.push({
      path: name,
      name,
      sizeBytes: stat.size,
      updatedAt: stat.mtimeMs
    });
  }
}

async function walkMemoryFiles(root, workspace, out) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'openclaw-web-ui') continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkMemoryFiles(target, workspace, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const rel = path.relative(workspace, target);
    if (!MEMORY_FILE_EXTENSIONS.has(ext) || !isMemoryRelatedRelative(rel)) continue;
    const stat = await fsp.stat(target);
    out.push({
      path: rel.split(path.sep).join('/'),
      name: path.basename(target),
      sizeBytes: stat.size,
      updatedAt: stat.mtimeMs
    });
  }
}

async function listMemoryFiles(agentId = 'all') {
  const [config, agents] = await Promise.all([readConfig(), getAgents()]);
  const workspace = path.resolve(defaultWorkspace(config));
  const files = [];
  if (agentId && agentId !== 'all') await validateAgentId(agentId);
  if (!agentId || agentId === 'all' || agentId === 'main') {
    await addRootMemoryFiles(workspace, files);
    await walkMemoryFiles(path.join(workspace, 'memory'), workspace, files);
    await walkMemoryFiles(path.join(workspace, '.learnings'), workspace, files);
  }
  if (agentId && agentId !== 'all' && agentId !== 'main') {
    await walkMemoryFiles(path.join(workspace, 'agents', agentId), workspace, files);
  } else if (agentId === 'all') {
    for (const agent of agents.filter((item) => item.id !== 'main')) {
      await walkMemoryFiles(path.join(workspace, 'agents', agent.id), workspace, files);
    }
  }
  const unique = [...new Map(files.map((file) => [file.path, file])).values()]
    .sort((a, b) => a.path.localeCompare(b.path));
  return { root: workspace, files: unique };
}

async function syncState() {
  const [agents, skills, sessions, memory, taskData] = await Promise.all([
    getAgents(),
    listAvailableSkills(),
    allSessionsFlat(),
    listMemoryFiles('all'),
    loadTasks()
  ]);
  const agentState = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    identity: agent.identity,
    model: agent.model,
    thinkingDefault: agent.thinkingDefault,
    fastModeDefault: agent.fastModeDefault,
    skills: agent.skills || [],
    tools: agent.tools || {},
    workspace: agent.workspace
  }));
  const sessionState = sessions.map((session) => ({
    agentId: session.agentId,
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt,
    totalTokens: session.totalTokens,
    fileExists: session.fileExists
  }));
  const memoryState = memory.files.map((file) => ({
    path: file.path,
    updatedAt: file.updatedAt,
    sizeBytes: file.sizeBytes
  }));
  const taskState = {
    settings: taskData.settings,
    tasks: taskData.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      column: task.column,
      priority: task.priority,
      updatedAt: task.updatedAt,
      assignee: task.assignee,
      reviewer: task.reviewer,
      missionId: task.missionId
    }))
  };
  return {
    ok: true,
    checkedAt: nowIso(),
    versions: {
      agents: stableHash(agentState),
      skills: stableHash(skills.skills),
      sessions: stableHash(sessionState),
      memory: stableHash(memoryState),
      tasks: stableHash(taskState),
      swarm: stableHash({ agentState, sessionState, taskState })
    },
    counts: {
      agents: agents.length,
      skills: skills.skills.length,
      sessions: sessions.length,
      memoryFiles: memory.files.length,
      tasks: taskData.tasks.length
    }
  };
}

async function resolveMemoryFile(relPath) {
  if (!safeRelativeFilePath(relPath)) throw httpError(400, 'Invalid memory file path.');
  const config = await readConfig();
  const workspace = path.resolve(defaultWorkspace(config));
  const target = path.resolve(path.join(workspace, relPath));
  if (!isInside(target, workspace)) throw httpError(400, 'Invalid memory file path.');
  const rel = path.relative(workspace, target);
  if (!isMemoryRelatedRelative(rel) || !MEMORY_FILE_EXTENSIONS.has(path.extname(target))) {
    throw httpError(400, 'Only memory-related text files can be edited here.');
  }
  return { workspace, target, rel: rel.split(path.sep).join('/') };
}

async function readMemoryFile(relPath) {
  const { target, rel } = await resolveMemoryFile(relPath);
  if (!(await exists(target))) throw httpError(404, 'Memory file not found.');
  return { path: rel, content: await readTextIfExists(target, 250000) };
}

async function writeMemoryFile(relPath, content) {
  const { target, rel } = await resolveMemoryFile(relPath);
  const value = String(content || '').slice(0, 250000);
  const backup = `${target}.webui-${Date.now()}.bak`;
  if (await exists(target)) await fsp.copyFile(target, backup);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
  return { ok: true, path: rel, backup: (await exists(backup)) ? backup : null };
}

async function buildSwarmSnapshot() {
  const [agents, taskData, sessionGroups] = await Promise.all([
    getAgents(),
    loadTasks(),
    listAllSessions()
  ]);
  const tasks = taskData.tasks.map(migrateTask);
  const sessionsByAgent = new Map(sessionGroups.map((group) => [group.agentId, group.sessions]));
  const workerAgents = agents.filter((agent) => !agent.isDefault);
  const workers = workerAgents.map((agent) => {
    const assigned = tasks.filter((task) => task.assignee === agent.id && task.column !== 'done');
    const current = assigned.find((task) => task.column === 'in_progress')
      || assigned.find((task) => task.column === 'review')
      || assigned.find((task) => task.column === 'blocked')
      || assigned[0]
      || null;
    const sessions = sessionsByAgent.get(agent.id) || [];
    const latest = sessions[0] || null;
    return {
      id: agent.id,
      name: agent.name || agent.id,
      displayName: agent.identity?.name || agent.name || agent.id,
      role: agentRole(agent),
      specialty: agent.identity?.theme || agentRole(agent),
      model: agent.model || '',
      provider: modelProvider(agent.model),
      mission: agentMission(agent),
      skills: agent.skills || [],
      capabilities: [
        'direct-chat',
        'task-lane',
        'session-logs',
        ...(Object.keys(agent.tools || {}).length ? ['tools-configured'] : [])
      ],
      defaultCwd: agent.workspace,
      preferredTaskTypes: [agentRole(agent).toLowerCase()],
      maxConcurrentTasks: 1,
      acceptsBroadcast: true,
      reviewRequired: agent.id === 'verifier',
      assignedTaskCount: assigned.length,
      cronJobCount: sessions.filter((session) => session.kind === 'cron').length,
      currentTaskId: current?.id || null,
      currentTask: current?.title || null,
      currentLane: current ? swarmLaneFromTask(current) : 'ready',
      lastSessionTitle: current?.title || latest?.kind || null,
      lastInteractionAt: latest?.updatedAt || null,
      status: current ? 'online' : latest ? 'idle' : 'offline'
    };
  });
  return { agents, workerAgents, workers, tasks, sessionsByAgent };
}

async function swarmHealth() {
  const snapshot = await buildSwarmSnapshot();
  const providers = [...new Set(snapshot.workers.map((worker) => worker.provider).filter(Boolean))];
  return {
    ok: true,
    workspaceModel: snapshot.agents.find((agent) => agent.isDefault)?.model || null,
    summary: {
      totalWorkers: snapshot.workers.length,
      totalAuthErrors24h: 0,
      distinctProviders: providers
    },
    checkedAt: Date.now()
  };
}

async function swarmRoster() {
  const snapshot = await buildSwarmSnapshot();
  return {
    ok: true,
    roster: { workers: snapshot.workers },
    workers: snapshot.workers,
    checkedAt: Date.now()
  };
}

async function swarmPlaybooks() {
  const snapshot = await buildSwarmSnapshot();
  const workerIds = new Set(snapshot.workers.map((worker) => worker.id));
  return {
    ok: true,
    playbooks: Object.values(SWARM_PLAYBOOKS).map((playbook) => ({
      id: playbook.id,
      label: playbook.label,
      description: playbook.description,
      defaultWorkers: playbook.defaultWorkers.filter((id) => workerIds.has(id))
    }))
  };
}

async function swarmRuntime() {
  const snapshot = await buildSwarmSnapshot();
  const byAgent = new Map(snapshot.workerAgents.map((agent) => [agent.id, agent]));
  const entries = [];
  for (const worker of snapshot.workers) {
    const agent = byAgent.get(worker.id);
    const sessions = snapshot.sessionsByAgent.get(worker.id) || [];
    const tail = await latestSessionTail(worker.id, sessions);
    const currentTask = worker.currentTaskId
      ? snapshot.tasks.find((task) => task.id === worker.currentTaskId)
      : null;
    entries.push({
      workerId: worker.id,
      displayName: worker.displayName,
      role: worker.role,
      currentTask: worker.currentTask || null,
      recentLogTail: tail.tail,
      pid: null,
      startedAt: toMillis(currentTask?.startedAt),
      lastOutputAt: worker.lastInteractionAt || null,
      cwd: agent?.workspace || null,
      phase: currentTask ? swarmLaneFromTask(currentTask) : null,
      lastSummary: currentTask?.result || null,
      lastResult: currentTask?.result || null,
      blockedReason: currentTask?.error || null,
      checkpointStatus: currentTask ? checkpointStatus(currentTask) : null,
      needsHuman: currentTask ? ['review', 'blocked'].includes(swarmLaneFromTask(currentTask)) : false,
      assignedTaskCount: worker.assignedTaskCount,
      cronJobCount: worker.cronJobCount,
      tmuxSession: null,
      tmuxAttachable: false,
      logPath: tail.logPath,
      terminalKind: tail.logPath ? 'log-tail' : 'none',
      lastSessionStartedAt: worker.lastInteractionAt || null,
      source: 'openclaw-web-ui',
      artifacts: [],
      previews: []
    });
  }
  return {
    ok: true,
    entries,
    tmuxAvailable: false,
    checkedAt: Date.now()
  };
}

function summarizeMission(id, title, tasks) {
  return {
    id,
    title,
    state: tasks.some((task) => task.column === 'blocked') ? 'blocked'
      : tasks.every((task) => task.column === 'done') ? 'done'
        : tasks.some((task) => task.column === 'in_progress') ? 'running'
          : 'ready',
    assignments: tasks.map((task) => ({
      id: task.id,
      state: swarmLaneFromTask(task),
      task: task.title,
      workerId: task.assignee || 'main',
      reviewRequired: Boolean(task.reviewer),
      completedAt: toMillis(task.endedAt),
      dispatchedAt: toMillis(task.startedAt),
      checkpoint: {
        stateLabel: checkpointStatus(task),
        checkpointStatus: checkpointStatus(task),
        runtimeState: swarmLaneFromTask(task),
        filesChanged: null,
        commandsRun: null,
        result: task.result || null,
        blocker: task.error || null,
        nextAction: task.column === 'blocked' ? 'Needs operator input' : task.column === 'review' ? 'Needs review' : null
      }
    })),
    updatedAt: Math.max(...tasks.map((task) => toMillis(task.updatedAt) || 0), Date.now())
  };
}

async function swarmMissions(limit = 50) {
  const data = await loadTasks();
  const tasks = data.tasks.map(migrateTask);
  const groups = new Map();
  for (const task of tasks) {
    const id = task.missionId || task.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(task);
  }
  const missions = [...groups.entries()].map(([id, grouped]) => summarizeMission(
    id,
    grouped[0]?.missionTitle || grouped[0]?.title || 'OpenClaw mission',
    grouped
  ));
  missions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, missions: missions.slice(0, Math.max(1, Math.min(Number(limit) || 50, 100))) };
}

function assignmentTitle(agent, goal, playbook) {
  const role = agentRole(agent);
  const action = {
    Builder: 'Implement',
    Research: 'Research',
    Analyzer: 'Analyze',
    Reviewer: 'Verify',
    Ops: 'Stabilize',
    Study: 'Explain'
  }[role] || 'Handle';
  return `${action}: ${goal.slice(0, 118)}`;
}

function assignmentBrief(agent, goal, playbook) {
  return [
    `Mission playbook: ${playbook.label}`,
    playbook.description,
    '',
    'Your lane:',
    roleBrief(agent, playbook),
    '',
    'Mission goal:',
    goal,
    '',
    'Output format:',
    '- What you did or learned.',
    '- Evidence: files, commands, sources, screenshots, or calculations.',
    '- Blockers or assumptions.',
    '- Next action for Atlas or the maintainer.'
  ].join('\n');
}

function assignmentCriteria(agent, playbook) {
  const role = agentRole(agent);
  const byRole = {
    Builder: [
      'Changed files or inspected files are named.',
      'Checks or tests are listed with pass/fail result.'
    ],
    Research: [
      'Important claims are source-backed.',
      'Dates and uncertainty are stated when recency matters.'
    ],
    Analyzer: [
      'Findings separate evidence, inference, assumptions, and risk.',
      'Recommendations are ranked or clearly prioritized.'
    ],
    Reviewer: [
      'Pass/fail verdict is explicit.',
      'Residual risk and missing coverage are stated.'
    ],
    Ops: [
      'Runtime state and commands checked are listed.',
      'Service-disrupting actions are only proposed unless approved.'
    ],
    Study: [
      'Finance/math work shows formulas, assumptions, units, and interpretation.',
      'Practice or study output is concise and usable.'
    ]
  };
  return [
    ...(byRole[role] || ['Checkpoint includes useful evidence.']),
    'External actions are only drafted unless the maintainer explicitly approved them.'
  ];
}

async function decomposeSwarmMission(input) {
  const goal = String(input.goal || input.prompt || input.message || '').trim();
  if (!goal) throw httpError(400, 'Mission goal is required.');
  const playbook = swarmPlaybook(input.playbook, goal);
  const snapshot = await buildSwarmSnapshot();
  const requested = Array.isArray(input.workerIds) ? input.workerIds.filter(safeAgentId) : [];
  const targetWorkers = (requested.length
    ? snapshot.workerAgents.filter((agent) => requested.includes(agent.id))
    : snapshot.workerAgents.filter((agent) => playbook.defaultWorkers.includes(agent.id))
  );
  const workers = targetWorkers.length ? targetWorkers : snapshot.workerAgents;
  if (!workers.length) throw httpError(400, 'No worker agents available.');
  const missionId = crypto.randomUUID();
  const created = [];
  const hasVerifier = snapshot.workerAgents.some((agent) => agent.id === 'verifier');
  for (const agent of workers) {
    created.push(await addTask({
      title: assignmentTitle(agent, goal, playbook),
      details: assignmentBrief(agent, goal, playbook),
      priority: input.priority || 'normal',
      column: input.column || 'todo',
      assignee: agent.id,
      reviewer: agent.id === 'verifier' || !hasVerifier ? '' : 'verifier',
      missionId,
      missionTitle: goal.slice(0, 200),
      acceptanceCriteria: assignmentCriteria(agent, playbook),
      createdBy: `swarm-${playbook.id}`
    }));
  }
  return {
    ok: true,
    playbook: {
      id: playbook.id,
      label: playbook.label,
      description: playbook.description
    },
    mission: summarizeMission(missionId, goal.slice(0, 200), created.map(migrateTask)),
    cards: created.map(taskToSwarmCard)
  };
}

async function dispatchSwarm(input) {
  const message = String(input.message || input.prompt || '').trim();
  if (!message) throw httpError(400, 'Dispatch message is required.');
  const snapshot = await buildSwarmSnapshot();
  const mode = ['auto', 'manual', 'broadcast'].includes(input.mode) ? input.mode : 'manual';
  const requested = Array.isArray(input.workerIds)
    ? input.workerIds.filter(safeAgentId)
    : safeAgentId(input.workerId) ? [input.workerId] : [];
  let targets = mode === 'broadcast'
    ? snapshot.workerAgents
    : snapshot.workerAgents.filter((agent) => requested.includes(agent.id));
  if (mode === 'auto' && !targets.length) {
    const lc = message.toLowerCase();
    targets = snapshot.workerAgents.filter((agent) => {
      const role = agentRole(agent).toLowerCase();
      return lc.includes(role) || lc.includes(agent.id.toLowerCase());
    });
    if (!targets.length) targets = snapshot.workerAgents.slice(0, 1);
  }
  if (!targets.length) throw httpError(400, 'No worker targets selected.');
  if (input.dryRun) {
    return { ok: true, mode, dryRun: true, targets: targets.map((agent) => agent.id), results: [] };
  }

  const results = [];
  for (const agent of targets) {
    const prompt = [
      `OpenClaw swarm dispatch for ${agent.identity?.name || agent.id}.`,
      'Stay inside local OpenClaw safety rules. Do not take outward-facing actions unless this dispatch explicitly approves them.',
      '',
      message
    ].join('\n');
    try {
      const result = await sendChat(agent.id, prompt, input.sessionId || '');
      results.push({ workerId: agent.id, ok: true, ...result });
    } catch (err) {
      results.push({ workerId: agent.id, ok: false, error: err.message || String(err) });
    }
  }
  return { ok: results.every((result) => result.ok), mode, targets: targets.map((agent) => agent.id), results };
}

async function swarmKanban() {
  const data = await loadTasks();
  return {
    ok: true,
    cards: data.tasks.map(taskToSwarmCard),
    backend: {
      id: 'local',
      label: 'OpenClaw local task store',
      detected: true,
      writable: true,
      details: 'Backed by openclaw-web-ui/data/tasks.json',
      path: TASKS_PATH
    }
  };
}

async function createSwarmKanbanCard(input) {
  const title = String(input.title || '').trim();
  if (!title) throw httpError(400, 'Card title is required.');
  const task = await addTask({
    title,
    details: String(input.spec || input.details || '').slice(0, 12000),
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [],
    assignee: safeAgentId(input.assignedWorker) ? input.assignedWorker : 'main',
    reviewer: safeAgentId(input.reviewer) ? input.reviewer : '',
    missionId: safeTaskId(input.missionId) ? input.missionId : '',
    column: columnFromSwarmLane(input.status),
    priority: input.priority || 'normal',
    createdBy: 'swarm-kanban'
  });
  return { ok: true, card: taskToSwarmCard(task) };
}

async function updateSwarmKanbanCard(input) {
  if (!safeTaskId(input.id)) throw httpError(400, 'Card id is required.');
  const patch = {};
  if ('title' in input) patch.title = input.title;
  if ('spec' in input) patch.details = input.spec;
  if ('acceptanceCriteria' in input) patch.acceptanceCriteria = input.acceptanceCriteria;
  if ('assignedWorker' in input) patch.assignee = input.assignedWorker || 'main';
  if ('reviewer' in input) patch.reviewer = input.reviewer || '';
  if ('missionId' in input) patch.missionId = input.missionId || '';
  if ('status' in input) patch.column = columnFromSwarmLane(input.status);
  const task = await patchTask(input.id, patch);
  return { ok: true, card: taskToSwarmCard(task) };
}

async function swarmReports() {
  const [missions, runtime] = await Promise.all([swarmMissions(100), swarmRuntime()]);
  const inbox = {
    needsReview: missions.missions.flatMap((mission) => mission.assignments || []).filter((item) => item.state === 'review').length,
    blocked: missions.missions.flatMap((mission) => mission.assignments || []).filter((item) => item.state === 'blocked').length,
    ready: missions.missions.flatMap((mission) => mission.assignments || []).filter((item) => item.state === 'ready').length
  };
  return {
    ok: true,
    inbox,
    missions: missions.missions,
    recentUpdates: runtime.entries.map((entry) => ({
      workerId: entry.workerId,
      workerName: entry.displayName || entry.workerId,
      text: entry.currentTask || entry.lastSummary || 'Ready for task',
      age: entry.lastOutputAt ? new Date(entry.lastOutputAt).toISOString() : '',
      tone: entry.blockedReason ? 'warning' : entry.currentTask ? 'active' : 'idle'
    }))
  };
}

function parseListField(value, fieldName) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split('\n').map((item) => item.trim()).filter(Boolean);
  throw httpError(400, `${fieldName} must be an array or newline list.`);
}

function parseObjectField(value, fieldName) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      throw httpError(400, `${fieldName} must be valid JSON.`);
    }
  }
  throw httpError(400, `${fieldName} must be an object.`);
}

async function updateAgentConfig(agentId, input) {
  const agent = await validateAgentId(agentId);
  const config = await readConfig();
  const list = config.agents.list || [];
  let entry = list.find((item) => item.id === agentId);
  if (!entry) {
    entry = { id: agentId };
    list.push(entry);
    config.agents.list = list;
  }

  if ('name' in input) entry.name = String(input.name || agentId).slice(0, 80);
  if ('model' in input) entry.model = String(input.model || '').slice(0, 160);
  if ('thinkingDefault' in input) entry.thinkingDefault = String(input.thinkingDefault || '').slice(0, 40);
  if ('fastModeDefault' in input) entry.fastModeDefault = Boolean(input.fastModeDefault);
  if ('skills' in input) entry.skills = parseListField(input.skills, 'skills').slice(0, 100);
  if ('tools' in input) entry.tools = parseObjectField(input.tools, 'tools');
  if ('identity' in input && input.identity && typeof input.identity === 'object') {
    entry.identity = {
      ...(entry.identity || {}),
      name: String(input.identity.name || agent.identity.name || agentId).slice(0, 80),
      emoji: String(input.identity.emoji || agent.identity.emoji || '').slice(0, 16),
      theme: String(input.identity.theme || agent.identity.theme || '').slice(0, 80)
    };
  }
  if (agentId === 'main') {
    if ('model' in input && entry.model) config.agents.defaults.model = { primary: entry.model };
    if ('thinkingDefault' in input) config.agents.defaults.thinkingDefault = entry.thinkingDefault;
    if ('fastModeDefault' in input) config.agents.defaults.fastModeDefault = entry.fastModeDefault;
    if ('skills' in input) config.agents.defaults.skills = entry.skills;
  }

  const backupPath = `${CONFIG_PATH}.webui-${Date.now()}.bak`;
  await fsp.copyFile(CONFIG_PATH, backupPath);
  await writeJsonAtomic(CONFIG_PATH, config);
  try {
    await runOpenClaw(['config', 'validate'], { timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 });
  } catch (err) {
    await fsp.copyFile(backupPath, CONFIG_PATH);
    throw httpError(400, `Config validation failed and was reverted: ${err.stderr || err.message}`);
  }

  if ('personality' in input) {
    await writeAgentMarkdown(agent.workspace, 'SOUL.md', String(input.personality || '').slice(0, 40000));
  }
  if ('instructions' in input) {
    await writeAgentMarkdown(agent.workspace, 'AGENTS.md', String(input.instructions || '').slice(0, 60000));
  }

  return (await getAgents()).find((item) => item.id === agentId);
}

async function writeAgentMarkdown(workspace, fileName, value) {
  const config = await readConfig();
  const root = path.resolve(defaultWorkspace(config));
  const target = path.resolve(path.join(workspace, fileName));
  if (!isInside(target, root)) throw httpError(400, 'Refusing to write outside the OpenClaw workspace.');
  const backup = `${target}.webui-${Date.now()}.bak`;
  if (await exists(target)) await fsp.copyFile(target, backup);
  await fsp.writeFile(target, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError(400, 'Body must be JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(path.join(PUBLIC_DIR, requested));
  const publicRoot = path.resolve(PUBLIC_DIR);
  if (!isInside(target, publicRoot)) return text(res, 403, 'Forbidden');
  try {
    const body = await fsp.readFile(target);
    const ext = path.extname(target);
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webp': 'image/webp'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    text(res, 404, 'Not found');
  }
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      app: 'openclaw-web-ui',
      mock: MOCK,
      configPath: CONFIG_PATH,
      time: nowIso()
    });
  }

  if (req.method === 'GET' && pathname === '/api/agents') {
    return json(res, 200, { agents: await getAgents() });
  }

  if (req.method === 'GET' && pathname === '/api/skills') {
    return json(res, 200, await listAvailableSkills());
  }

  if (req.method === 'GET' && pathname === '/api/sync-state') {
    return json(res, 200, await syncState());
  }

  if (req.method === 'GET' && pathname === '/api/dashboard') {
    return json(res, 200, await dashboardSummary());
  }

  if (req.method === 'GET' && pathname === '/api/swarm-health') {
    return json(res, 200, await swarmHealth());
  }

  if (req.method === 'GET' && pathname === '/api/swarm-roster') {
    return json(res, 200, await swarmRoster());
  }

  if (req.method === 'GET' && pathname === '/api/swarm-playbooks') {
    return json(res, 200, await swarmPlaybooks());
  }

  if (req.method === 'GET' && pathname === '/api/swarm-runtime') {
    return json(res, 200, await swarmRuntime());
  }

  if (req.method === 'GET' && pathname === '/api/swarm-missions') {
    return json(res, 200, await swarmMissions(searchParams.get('limit') || 50));
  }

  if (req.method === 'GET' && pathname === '/api/swarm-reports') {
    return json(res, 200, await swarmReports());
  }

  if (req.method === 'GET' && pathname === '/api/swarm-kanban') {
    return json(res, 200, await swarmKanban());
  }

  if (req.method === 'POST' && pathname === '/api/swarm-kanban') {
    return json(res, 201, await createSwarmKanbanCard(await readBody(req)));
  }

  if (req.method === 'PATCH' && pathname === '/api/swarm-kanban') {
    return json(res, 200, await updateSwarmKanbanCard(await readBody(req)));
  }

  if (req.method === 'POST' && pathname === '/api/swarm-decompose') {
    return json(res, 201, await decomposeSwarmMission(await readBody(req)));
  }

  if (req.method === 'POST' && pathname === '/api/swarm-dispatch') {
    return json(res, 200, await dispatchSwarm(await readBody(req)));
  }

  if (req.method === 'GET' && pathname === '/api/swarm-chat') {
    const workerId = searchParams.get('workerId') || '';
    await validateAgentId(workerId);
    const sessions = await listSessions(workerId);
    const tail = await latestSessionTail(workerId, sessions, Number(searchParams.get('limit') || 20));
    return json(res, 200, { ok: true, workerId, messages: tail.tail ? tail.tail.split('\n') : [], latest: tail.latest });
  }

  if (req.method === 'POST' && pathname === '/api/swarm-direct-chat') {
    const body = await readBody(req);
    const workerId = body.workerId || body.agentId || '';
    return json(res, 200, { ok: true, workerId, reply: await sendChat(workerId, body.message || body.prompt || '', body.sessionId || '') });
  }

  if (req.method === 'POST' && pathname === '/api/chat/stream') {
    return streamChat(req, res, await readBody(req));
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await readBody(req);
    return json(res, 200, await sendChat(body.agentId || 'main', body.message || '', body.sessionId || ''));
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const agentId = searchParams.get('agent') || 'main';
    return json(res, 200, { agentId, sessions: await listSessions(agentId) });
  }

  if (req.method === 'GET' && pathname === '/api/sessions/all') {
    return json(res, 200, { sessions: await allSessionsFlat() });
  }

  if (req.method === 'GET' && pathname === '/api/search-sessions') {
    return json(res, 200, await searchSessionLogs(searchParams.get('q') || ''));
  }

  const exportMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
  if (req.method === 'GET' && exportMatch) {
    const payload = await exportAgentSessions(exportMatch[1]);
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${exportMatch[1]}-sessions-export.json"`,
      'cache-control': 'no-store'
    });
    res.end(body);
    return;
  }

  const previewMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/preview$/);
  if (req.method === 'GET' && previewMatch) {
    return json(res, 200, await loadSessionPreview(previewMatch[1], previewMatch[2]));
  }

  const downloadMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/download$/);
  if (req.method === 'GET' && downloadMatch) {
    const filePath = await sessionLogPath(downloadMatch[1], downloadMatch[2]);
    const fileName = `${downloadMatch[1]}-${downloadMatch[2]}.jsonl`;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/memory-files') {
    return json(res, 200, await listMemoryFiles(searchParams.get('agent') || 'all'));
  }

  if (req.method === 'GET' && pathname === '/api/memory-file') {
    return json(res, 200, await readMemoryFile(searchParams.get('path') || ''));
  }

  if (req.method === 'PUT' && pathname === '/api/memory-file') {
    const body = await readBody(req);
    return json(res, 200, await writeMemoryFile(body.path || '', body.content || ''));
  }

  if (req.method === 'GET' && pathname === '/api/tasks') {
    return json(res, 200, await loadTasks());
  }

  if (req.method === 'POST' && pathname === '/api/tasks') {
    return json(res, 201, { task: await addTask(await readBody(req)) });
  }

  if (req.method === 'POST' && pathname === '/api/tasks/settings') {
    return json(res, 200, { settings: await updateTaskSettings(await readBody(req)) });
  }

  if (req.method === 'POST' && pathname === '/api/tasks/run') {
    return json(res, 200, await runQueue());
  }

  const taskRunMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (req.method === 'POST' && taskRunMatch) {
    return json(res, 200, { task: await runTaskById(taskRunMatch[1]) });
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') {
    return json(res, 200, { task: await patchTask(taskMatch[1], await readBody(req)) });
  }
  if (taskMatch && req.method === 'DELETE') {
    return json(res, 200, await deleteTask(taskMatch[1]));
  }

  const configMatch = pathname.match(/^\/api\/config\/([^/]+)$/);
  if (configMatch && req.method === 'POST') {
    return json(res, 200, { agent: await updateAgentConfig(configMatch[1], await readBody(req)) });
  }

  throw httpError(404, 'API route not found.');
}

function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url.pathname, url.searchParams);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      json(res, err.status || 500, {
        ok: false,
        error: err.message || String(err)
      });
    }
  });
}

async function start() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!(await exists(TASKS_PATH))) {
    await saveTasks({ settings: { mode: 'priority', autoRun: false }, tasks: [] });
  }
  const app = createApp();
  app.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    const address = app.address();
    const port = typeof address === 'object' ? address.port : DEFAULT_PORT;
    process.stdout.write(`OpenClaw Web UI listening on http://${DEFAULT_HOST}:${port}\n`);
  });

  setInterval(async () => {
    try {
      const data = await loadTasks();
      if (data.settings.autoRun) await runQueue();
    } catch (err) {
      process.stderr.write(`task auto-run error: ${err.message}\n`);
    }
  }, 30000).unref();
}

if (require.main === module) {
  start().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  getAgents,
  selectNextTask,
  atlasTaskPrompt,
  taskToSwarmCard,
  swarmLaneFromTask,
  TASK_COLUMNS
};
