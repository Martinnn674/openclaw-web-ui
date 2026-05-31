'use strict';

const COLUMNS = [
  ['backlog', 'Backlog'],
  ['todo', 'To Do'],
  ['in_progress', 'Running'],
  ['review', 'Review'],
  ['blocked', 'Blocked'],
  ['done', 'Done']
];

const SWARM_LANES = [
  ['backlog', 'Backlog'],
  ['ready', 'Ready'],
  ['running', 'Running'],
  ['review', 'Review'],
  ['blocked', 'Blocked'],
  ['done', 'Done']
];

const PRIORITY_WEIGHT = { urgent: 4, high: 3, normal: 2, low: 1 };
const MEMORY_PAGE_SIZE = 20;
const CHAT_MAX_FILES = 5;
const CHAT_FILE_TEXT_LIMIT = 4200;
const CHAT_MESSAGE_LIMIT = 23500;
const ACTIVITY_PREVIEW_CHARS = 1800;
const SYNC_INTERVAL_MS = 4000;
const SWARM_PLAYBOOKS = [
  {
    id: 'build',
    label: 'Build or Fix',
    description: 'Research, implement, verify.',
    workers: ['researcher', 'coder', 'verifier']
  },
  {
    id: 'research',
    label: 'Research Brief',
    description: 'Sources, analysis, citation check.',
    workers: ['researcher', 'analyzer', 'verifier']
  },
  {
    id: 'finance',
    label: 'Finance Study',
    description: 'University finance work with data support.',
    workers: ['school', 'analyzer', 'researcher', 'verifier']
  },
  {
    id: 'ops',
    label: 'Ops Check',
    description: 'Gateway, services, logs, safe recovery.',
    workers: ['operator', 'verifier', 'coder']
  },
  {
    id: 'audit',
    label: 'Audit and Improve',
    description: 'Find risks, verify, then fix.',
    workers: ['analyzer', 'verifier', 'coder']
  }
];

const state = {
  agents: [],
  dashboard: null,
  health: null,
  selectedAgent: 'main',
  selectedSessionAgent: 'all',
  selectedSettingsAgent: 'main',
  pendingSessionPreview: null,
  chat: JSON.parse(localStorage.getItem('ocui.chat') || '{}'),
  chatSessionIds: JSON.parse(localStorage.getItem('ocui.chatSessionIds') || '{}'),
  chatNotices: {},
  chatAttachments: [],
  sessions: [],
  sidebarSessions: [],
  sessionPage: 1,
  skillCatalog: [],
  memoryView: 'sessions',
  memoryFiles: [],
  memoryFilePage: 1,
  selectedMemoryPath: '',
  selectedMemoryAgent: 'all',
  sync: { versions: null, inFlight: false, timer: null, lastAt: 0 },
  tasks: [],
  taskSettings: { mode: 'priority', autoRun: false },
  swarm: {
    view: localStorage.getItem('ocui.swarm.view') || 'cards',
    playbook: localStorage.getItem('ocui.swarm.playbook') || 'build',
    selectedWorker: localStorage.getItem('ocui.swarm.selected') || '',
    roomIds: JSON.parse(localStorage.getItem('ocui.swarm.room') || '[]'),
    health: null,
    roster: [],
    runtime: [],
    tmuxAvailable: false,
    missions: [],
    cards: [],
    reports: null,
    dispatchLog: ''
  }
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

async function api(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function streamApi(path, body, handlers = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  if (!response.body) throw new Error('Streaming is not available in this browser.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7).trim() || 'message';
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      let payload = {};
      try {
        payload = JSON.parse(dataLine.slice(6));
      } catch {
        payload = { text: dataLine.slice(6) };
      }
      handlers[event]?.(payload);
    }
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function roleClass(role) {
  const text = String(role || '').toLowerCase();
  if (/(user|human|me)/.test(text)) return 'user';
  if (/(assistant|agent|bot|model)/.test(text)) return 'assistant';
  if (/(tool|function|command)/.test(text)) return 'tool';
  if (/(reason|thinking|thought)/.test(text)) return 'reasoning';
  return text.replace(/[^a-z0-9_-]+/g, '-') || 'message';
}

function saveChat() {
  localStorage.setItem('ocui.chat', JSON.stringify(state.chat));
  localStorage.setItem('ocui.chatSessionIds', JSON.stringify(state.chatSessionIds));
}

function setTheme(theme) {
  const aliases = {
    'claude-nous-light': 'claw-light',
    'claude-nous': 'hermes-dark',
    night: 'hermes-dark'
  };
  const normalized = aliases[theme] || theme || 'claw-light';
  localStorage.setItem('ocui.theme', normalized);
  const resolved = normalized === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'claw-light' : 'hermes-dark')
    : normalized;
  document.documentElement.dataset.theme = resolved;
  if ($('#themeSelect')) $('#themeSelect').value = normalized;
}

function formatDate(value) {
  if (!value) return 'No date';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function agentLabel(agent) {
  return agent?.identity?.name || agent?.name || agent?.id || 'Agent';
}

function agentEmoji(agent) {
  return agent?.identity?.emoji || (agent?.id === 'main' ? '⚡' : '◎');
}

function agentInitial(agent) {
  const label = agentLabel(agent);
  return label.slice(0, 2).toUpperCase();
}

function shortText(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sortByRecent(items, primary = 'updatedAt') {
  return [...items].sort((a, b) => {
    const left = Number(b[primary] || b.startedAt || b.updatedAt || 0);
    const right = Number(a[primary] || a.startedAt || a.updatedAt || 0);
    return left - right || String(a.path || a.sessionId || '').localeCompare(String(b.path || b.sessionId || ''));
  });
}

function pageItems(items, page, pageSize = MEMORY_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  return {
    totalPages,
    page: safePage,
    start: (safePage - 1) * pageSize,
    end: Math.min(items.length, safePage * pageSize),
    items: items.slice((safePage - 1) * pageSize, safePage * pageSize)
  };
}

function renderPager(kind, page, totalPages, totalItems) {
  if (totalItems <= MEMORY_PAGE_SIZE) return '';
  const pages = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, start + 4);
  for (let i = Math.max(1, end - 4); i <= end; i += 1) pages.push(i);
  return `
    <nav class="pager" aria-label="${kind} pagination">
      <button type="button" data-page-kind="${kind}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Prev</button>
      ${pages.map((item) => `
        <button type="button" class="${item === page ? 'is-active' : ''}" data-page-kind="${kind}" data-page="${item}">${item}</button>
      `).join('')}
      <button type="button" data-page-kind="${kind}" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Next</button>
    </nav>
  `;
}

function bindPager(root = document) {
  $$('[data-page-kind]', root).forEach((button) => {
    button.addEventListener('click', () => {
      const page = Number(button.dataset.page || 1);
      if (button.dataset.pageKind === 'sessions') {
        state.sessionPage = page;
        renderSessionList();
      } else if (button.dataset.pageKind === 'files') {
        state.memoryFilePage = page;
        renderMemoryFiles();
      }
    });
  });
}

function sessionDataAttrs(session) {
  return `data-session-agent="${escapeHtml(session.agentId)}" data-session-id="${escapeHtml(session.sessionId)}"`;
}

function sessionOpenAttrs(session) {
  return `${sessionDataAttrs(session)} data-open-session`;
}

function sessionStatusLabel(session) {
  if (!session.fileExists) return 'missing';
  return session.registered === false ? 'recovered' : 'log';
}

function sessionStatusClass(session) {
  if (!session.fileExists) return 'blocked';
  return session.registered === false ? 'review' : 'done';
}

function jsonDetails(value) {
  if (!value) return '';
  let body = '';
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return `<details class="message-details">
    <summary>Reasoning, tool calls, raw run</summary>
    <pre>${escapeHtml(body)}</pre>
  </details>`;
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function hasInlineNumberedList(block) {
  const numbers = [...String(block || '').matchAll(/(?:^|[ \t])(\d{1,2})\.\s+/g)].map((match) => Number(match[1]));
  return numbers.includes(1) && numbers.includes(2);
}

function normalizeRichText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => {
      if (!hasInlineNumberedList(block)) return block;
      return block
        .replace(/[ \t]+(1\.\s+)/, '\n\n$1')
        .replace(/[ \t]+(\d{1,2}\.\s+)/g, '\n$1');
    })
    .join('\n\n')
    .trim();
}

function renderTextBlock(block) {
  const trimmed = String(block || '').trim();
  if (!trimmed) return '';
  const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
  if (heading) return `<h4>${renderInlineMarkdown(heading[2])}</h4>`;
  const lines = trimmed.split('\n').filter((line) => line.trim());
  if (lines.length > 1 && lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
  }
  if (lines.length > 1 && lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    return `<ol>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
  }
  return `<p>${trimmed.split('\n').map(renderInlineMarkdown).join('<br>')}</p>`;
}

function renderCodeBlock(code, language = '', className = 'message-code') {
  const label = String(language || '').trim();
  return `<div class="${escapeHtml(className)}">
    ${label ? `<div class="code-label">${escapeHtml(label)}</div>` : ''}
    <pre><code>${escapeHtml(code).replace(/\n$/, '')}</code></pre>
  </div>`;
}

function formatCharCount(value) {
  return Number(value || 0).toLocaleString();
}

function renderExpandableCodeBlock(code, language = '', className = 'activity-code') {
  const text = String(code || '');
  if (text.length <= ACTIVITY_PREVIEW_CHARS) return renderCodeBlock(text, language, className);
  const preview = `${text.slice(0, ACTIVITY_PREVIEW_CHARS).replace(/\s+$/, '')}\n\n...`;
  return `<div class="activity-preview-note">Showing first ${formatCharCount(ACTIVITY_PREVIEW_CHARS)} of ${formatCharCount(text.length)} characters.</div>
    ${renderCodeBlock(preview, language, className)}
    <details class="activity-expand">
      <summary>Show full output</summary>
      ${renderCodeBlock(text, language, `${className} activity-code-full`)}
    </details>`;
}

function renderExpandableProse(text) {
  const value = String(text || '');
  if (value.length <= ACTIVITY_PREVIEW_CHARS) return `<div class="activity-prose">${renderRichText(value)}</div>`;
  const preview = value.slice(0, ACTIVITY_PREVIEW_CHARS).replace(/\s+$/, '');
  return `<div class="activity-preview-note">Showing first ${formatCharCount(ACTIVITY_PREVIEW_CHARS)} of ${formatCharCount(value.length)} characters.</div>
    <div class="activity-prose">${renderRichText(`${preview}\n\n...`)}</div>
    <details class="activity-expand">
      <summary>Show full output</summary>
      <div class="activity-prose activity-prose-full">${renderRichText(value)}</div>
    </details>`;
}

function renderRichText(value) {
  const text = normalizeRichText(value);
  if (!text) return '';
  const parts = [];
  const fence = /```([a-zA-Z0-9_+.-]*)[ \t]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fence.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(...text.slice(lastIndex, match.index).split(/\n{2,}/).map(renderTextBlock));
    }
    parts.push(renderCodeBlock(match[2], match[1]));
    lastIndex = fence.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(...text.slice(lastIndex).split(/\n{2,}/).map(renderTextBlock));
  }
  return parts.filter(Boolean).join('');
}

function looksStructuredText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/```/.test(text)) return true;
  if (/^(\{|\[)[\s\S]*(\}|\])$/.test(text)) return true;
  if (/^(---|\+\+\+|diff --git)\b/m.test(text)) return true;
  if (/\b(function|const|let|class|import|export|async|await|SELECT|INSERT|UPDATE|DELETE)\b/.test(text) && text.includes('\n')) return true;
  return text.split('\n').length > 6 && /[{}()[\];=<>]/.test(text);
}

function renderActivityText(item) {
  const text = String(item?.text || '');
  if (!text.trim()) return '';
  if (item?.format === 'code' || (item?.kind === 'tool' && looksStructuredText(text))) {
    return renderExpandableCodeBlock(text, item.language || '', 'activity-code');
  }
  return renderExpandableProse(text);
}

function isTextLikeFile(file) {
  const name = String(file.name || '').toLowerCase();
  return file.type.startsWith('text/')
    || /\.(txt|md|markdown|json|jsonl|csv|tsv|yaml|yml|xml|html|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|cc|cpp|h|hpp|sh|bash|zsh|fish|ps1|sql|log|ini|toml|env)$/i.test(name);
}

async function fileToAttachment(file) {
  const attachment = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name || 'untitled',
    type: file.type || 'unknown',
    size: file.size || 0,
    text: '',
    truncated: false,
    omitted: false
  };
  if (!isTextLikeFile(file)) {
    attachment.omitted = true;
    attachment.text = 'Binary file selected. The UI attached filename, type, and size, but omitted binary contents from the text prompt.';
    return attachment;
  }
  const content = await file.text();
  attachment.truncated = content.length > CHAT_FILE_TEXT_LIMIT;
  attachment.text = attachment.truncated ? content.slice(0, CHAT_FILE_TEXT_LIMIT) : content;
  return attachment;
}

function attachmentPrompt(attachments) {
  if (!attachments.length) return '';
  const sections = attachments.map((file) => {
    const flags = [
      file.type || 'unknown type',
      formatBytes(file.size),
      file.truncated ? `truncated to ${CHAT_FILE_TEXT_LIMIT} chars` : '',
      file.omitted ? 'contents omitted' : ''
    ].filter(Boolean).join(', ');
    return `--- ${file.name} (${flags}) ---\n${file.text || '(empty file)'}`;
  });
  return `\n\nAttached files:\n${sections.join('\n\n')}`;
}

function buildChatPrompt(text, attachments) {
  const base = String(text || '').trim();
  const full = `${base}${attachmentPrompt(attachments)}`.trim();
  if (full.length <= CHAT_MESSAGE_LIMIT) return full;
  return `${full.slice(0, CHAT_MESSAGE_LIMIT)}\n\n[Attachment content truncated to fit chat limit.]`;
}

function renderAttachmentTray() {
  const tray = $('#chatAttachmentTray');
  if (!tray) return;
  const attachments = state.chatAttachments || [];
  tray.classList.toggle('is-empty', attachments.length === 0);
  tray.innerHTML = attachments.map((file) => `
    <span class="attachment-pill" title="${escapeHtml(file.name)}">
      <span class="attachment-icon">📄</span>
      <span class="attachment-name">${escapeHtml(file.name)}</span>
      <span class="attachment-size">${formatBytes(file.size)}</span>
      <button type="button" data-remove-attachment="${escapeHtml(file.id)}" aria-label="Remove ${escapeHtml(file.name)}">×</button>
    </span>
  `).join('');
  $$('[data-remove-attachment]', tray).forEach((button) => {
    button.addEventListener('click', () => {
      state.chatAttachments = state.chatAttachments.filter((file) => file.id !== button.dataset.removeAttachment);
      renderAttachmentTray();
    });
  });
}

function renderMessageAttachments(attachments = []) {
  if (!attachments.length) return '';
  return `<div class="message-attachments">
    ${attachments.map((file) => `
      <span class="message-attachment">
        <span>${escapeHtml(file.name)}</span>
        <small>${formatBytes(file.size)}${file.truncated ? ' · truncated' : ''}${file.omitted ? ' · metadata only' : ''}</small>
      </span>
    `).join('')}
  </div>`;
}

async function handleChatFiles(event) {
  const files = Array.from(event.target.files || []).slice(0, CHAT_MAX_FILES);
  if (!files.length) return;
  const existing = state.chatAttachments || [];
  const slots = Math.max(0, CHAT_MAX_FILES - existing.length);
  const selected = files.slice(0, slots);
  try {
    const attachments = await Promise.all(selected.map(fileToAttachment));
    state.chatAttachments = [...existing, ...attachments];
  } catch (err) {
    ensureChat(state.selectedAgent).push({ role: 'agent', text: `File upload failed: ${err.message}`, at: new Date().toISOString(), status: 'error' });
    saveChat();
    renderMessages('agentMessages', state.selectedAgent);
  } finally {
    event.target.value = '';
    renderAttachmentTray();
  }
}

function readableText(value, depth = 0) {
  if (value == null || depth > 2) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => readableText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (value.arguments) {
      let args = '';
      try {
        args = JSON.stringify(value.arguments, null, 2);
      } catch {
        args = String(value.arguments);
      }
      return [`Tool call: ${value.name || value.toolName || 'tool'}`, args].filter(Boolean).join('\n');
    }
    return readableText(value.text, depth + 1)
      || readableText(value.thinking, depth + 1)
      || readableText(value.content, depth + 1)
      || readableText(value.message, depth + 1)
      || readableText(value.summary, depth + 1)
      || readableText(value.output, depth + 1)
      || readableText(value.result, depth + 1)
      || readableText(value.input, depth + 1)
      || readableText(value.name, depth + 1)
      || readableText(value.title, depth + 1);
  }
  return '';
}

function classifyRunItem(item) {
  const type = String(item?.type || item?.kind || item?.event || item?.role || item?.name || item?.toolName || '').toLowerCase();
  if (/(reason|thinking|thought)/.test(type)) return { kind: 'reasoning', label: 'Thinking' };
  if (/(tool|function|command|exec|call)/.test(type)) return { kind: 'tool', label: item?.toolName || item?.name || 'Tool' };
  if (/(error|failed|failure)/.test(type)) return { kind: 'error', label: 'Error' };
  return null;
}

function collectRunItems(raw) {
  const roots = [
    raw?.events,
    raw?.items,
    raw?.output,
    raw?.messages,
    raw?.result?.events,
    raw?.result?.items,
    raw?.result?.output,
    raw?.result?.messages,
    raw?.result?.steps,
    raw?.response?.output
  ].filter(Array.isArray);
  const seen = new Set();
  const items = [];
  roots.flat().forEach((item) => {
    const classified = classifyRunItem(item);
    if (!classified) return;
    const text = String(readableText(item) || '').trim();
    const key = `${classified.kind}:${classified.label}:${text}`;
    if (!text || seen.has(key)) return;
    seen.add(key);
    items.push({
      ...classified,
      text,
      format: item?.format || (classified.kind === 'tool' || looksStructuredText(text) ? 'code' : 'markdown')
    });
  });
  if (!items.length && raw) {
    const status = raw.status || raw.result?.status;
    const runId = raw.runId || raw.id;
    if (status || runId) {
      items.push({ kind: 'status', label: 'Run', text: [status || 'ok', runId ? `run ${runId}` : ''].filter(Boolean).join(' · ') });
    }
  }
  return items.slice(0, 12);
}

function renderRunActivity(message) {
  const items = message.events || collectRunItems(message.raw);
  if (!items.length && !message.raw) return '';
  return `<div class="message-activity">
    ${items.map((item) => `
      <div class="activity-item ${escapeHtml(roleClass(item.kind || 'status'))}">
        <div class="activity-head">
          <strong>${escapeHtml(item.label || item.kind || 'Run')}</strong>
          ${item.at ? `<time>${escapeHtml(formatDate(item.at))}</time>` : ''}
        </div>
        <div class="activity-body">${renderActivityText(item)}</div>
        ${item.clipped ? '<small class="activity-note">Live stream output clipped. Open the raw run for the complete payload.</small>' : ''}
      </div>
    `).join('')}
    ${message.raw ? jsonDetails(message.raw) : ''}
  </div>`;
}

function appendMessageEvent(message, event) {
  if (!event?.text) return;
  message.events ||= [];
  const key = `${event.kind || 'status'}:${event.label || ''}:${event.text}`;
  if (message.events.some((item) => `${item.kind || 'status'}:${item.label || ''}:${item.text}` === key)) return;
  message.events.push({
    kind: event.kind || 'status',
    label: event.label || 'Run',
    text: event.text,
    at: event.at || '',
    format: event.format || (event.kind === 'tool' || looksStructuredText(event.text) ? 'code' : 'markdown'),
    language: event.language || '',
    clipped: Boolean(event.clipped)
  });
}

function roleGlyph(role) {
  const key = String(role || '').toLowerCase();
  if (key.includes('build')) return 'B';
  if (key.includes('research')) return 'R';
  if (key.includes('analy')) return 'A';
  if (key.includes('review')) return 'V';
  if (key.includes('ops')) return 'O';
  if (key.includes('study')) return 'S';
  return 'W';
}

function runtimeFor(workerId) {
  return state.swarm.runtime.find((entry) => entry.workerId === workerId) || {};
}

function workerById(workerId) {
  return state.swarm.roster.find((worker) => worker.id === workerId) || state.agents.find((agent) => agent.id === workerId) || { id: workerId };
}

function activeSwarmPlaybook() {
  return SWARM_PLAYBOOKS.find((playbook) => playbook.id === state.swarm.playbook) || SWARM_PLAYBOOKS[0];
}

function availablePlaybookWorkers(playbook = activeSwarmPlaybook()) {
  const available = new Set(state.swarm.roster.map((worker) => worker.id));
  return playbook.workers.filter((id) => available.has(id));
}

function missionWorkerIds() {
  const available = new Set(state.swarm.roster.map((worker) => worker.id));
  const selected = state.swarm.roomIds.filter((id) => available.has(id));
  if (selected.length) return selected;
  return availablePlaybookWorkers();
}

function setRecommendedSwarmTeam() {
  state.swarm.roomIds = availablePlaybookWorkers();
  if (!state.swarm.selectedWorker || !state.swarm.roomIds.includes(state.swarm.selectedWorker)) {
    state.swarm.selectedWorker = state.swarm.roomIds[0] || state.swarm.roster[0]?.id || '';
  }
}

function saveSwarmPrefs() {
  localStorage.setItem('ocui.swarm.view', state.swarm.view);
  localStorage.setItem('ocui.swarm.playbook', state.swarm.playbook || 'build');
  localStorage.setItem('ocui.swarm.selected', state.swarm.selectedWorker || '');
  localStorage.setItem('ocui.swarm.room', JSON.stringify(state.swarm.roomIds));
}

function laneLabel(lane) {
  return (SWARM_LANES.find(([id]) => id === lane) || [lane, lane])[1];
}

function taskLaneLabel(lane) {
  return (COLUMNS.find(([id]) => id === lane) || [lane, lane])[1];
}

function workerStatusClass(worker, runtime) {
  if (worker.currentLane === 'blocked' || runtime.blockedReason) return 'blocked';
  if (worker.status === 'offline') return 'offline';
  return '';
}

function setBusy(form, busy) {
  $$('button, textarea, input, select', form).forEach((item) => {
    item.disabled = busy;
  });
}

function activeTab() {
  return document.body.dataset.activeTab || 'dashboard';
}

function requestedTabFromLocation() {
  return new URLSearchParams(window.location.search).get('tab')
    || window.location.hash.replace(/^#/, '');
}

function activateLocationTab() {
  const requestedTab = requestedTabFromLocation();
  if (requestedTab && $(`#tab-${requestedTab}`) && activeTab() !== requestedTab) {
    setActiveTab(requestedTab);
    return true;
  }
  return false;
}

function navigateTab(tab) {
  if (!tab || !$(`#tab-${tab}`)) return;
  if (window.location.hash.replace(/^#/, '') !== tab) {
    window.location.hash = tab;
  } else {
    setActiveTab(tab);
  }
}

function formIsDirty(selector) {
  return $(`${selector}[data-dirty="1"]`) !== null;
}

function markFormClean(selector) {
  const form = $(selector);
  if (form) form.dataset.dirty = '0';
}

function markFormDirty(selector) {
  const form = $(selector);
  if (form) form.dataset.dirty = '1';
}

function settingsCanAutoRender() {
  return activeTab() !== 'settings' || !formIsDirty('#settingsForm');
}

function memoryCanAutoRender() {
  return activeTab() !== 'logs' || !formIsDirty('#memoryEditorForm');
}

function setActiveTab(tab) {
  document.body.dataset.activeTab = tab;
  $$('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === `tab-${tab}`));
  $$('.nav-item, .mobile-nav-btn').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  });
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'chat') refreshChatSessionState();
  if (tab === 'swarm') loadSwarm();
  if (tab === 'tasks') loadTasks();
  if (tab === 'logs') loadSessions();
  if (tab === 'settings') renderSettings();
}

async function loadHealth() {
  try {
    const data = await api('/api/health');
    state.health = data;
    $('#healthText').textContent = 'Online';
    $('#healthDot').classList.add('ok');
    $('#mobileHealth').textContent = data.security?.localOnly === false ? 'check bind' : 'online';
  } catch {
    state.health = null;
    $('#healthText').textContent = 'Offline';
    $('#healthDot').classList.remove('ok');
    $('#mobileHealth').textContent = 'offline';
  }
  renderSecurityStatus();
}

async function loadAgents() {
  const data = await api('/api/agents');
  state.agents = data.agents || [];
  const firstSubagent = state.agents.find((agent) => agent.id !== 'main')?.id || 'main';
  if (!state.agents.find((agent) => agent.id === state.selectedAgent)) state.selectedAgent = 'main';
  if (state.selectedAgent === 'main' && !state.agents.find((agent) => agent.id === 'main')) state.selectedAgent = firstSubagent;
  if (state.selectedSessionAgent !== 'all' && !state.agents.find((agent) => agent.id === state.selectedSessionAgent)) state.selectedSessionAgent = 'all';
  if (!state.agents.find((agent) => agent.id === state.selectedSettingsAgent)) state.selectedSettingsAgent = 'main';
  renderAgentOptions();
  renderAgents();
  renderMessages('agentMessages', state.selectedAgent);
  if (settingsCanAutoRender()) renderSettings();
  else $('#settingsState').textContent = 'External agent update available. Save or discard your edits to refresh.';
}

async function loadSkills() {
  try {
    const data = await api('/api/skills');
    state.skillCatalog = data.skills || [];
    if (settingsCanAutoRender()) renderSettings();
    else $('#settingsState').textContent = 'External skill update available. Save or discard your edits to refresh.';
  } catch {
    state.skillCatalog = [];
  }
}

function renderAgentOptions() {
  const allOptions = state.agents.map((agent) => `<option value="${agent.id}">${escapeHtml(agentLabel(agent))}</option>`).join('');
  $('#agentSelect').innerHTML = allOptions;
  $('#sessionAgentSelect').innerHTML = `<option value="all">All agents</option>${allOptions}`;
  $('#settingsAgentSelect').innerHTML = allOptions;
  $('#agentSelect').value = state.selectedAgent;
  $('#sessionAgentSelect').value = state.selectedSessionAgent;
  $('#settingsAgentSelect').value = state.selectedSettingsAgent;
  renderChatHeader();
}

function newChatSessionId() {
  const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-${id}`;
}

function messageSessionId(message) {
  return message?.sessionId
    || message?.raw?.result?.meta?.sessionId
    || message?.raw?.sessionId
    || message?.raw?.result?.sessionId
    || '';
}

function activeChatSessionId(agentId) {
  const stored = state.chatSessionIds[agentId];
  if (stored) return stored;
  const inferred = [...ensureChat(agentId)].reverse().map(messageSessionId).find(Boolean);
  if (inferred) {
    state.chatSessionIds[agentId] = inferred;
    saveChat();
  }
  return inferred || '';
}

function hasDetachedChat(agentId) {
  return ensureChat(agentId).length > 0 && !activeChatSessionId(agentId);
}

function ensureChatSessionId(agentId) {
  const existing = activeChatSessionId(agentId);
  if (existing) return existing;
  const sessionId = newChatSessionId();
  state.chatSessionIds[agentId] = sessionId;
  saveChat();
  return sessionId;
}

function setActiveChatSessionId(agentId, sessionId) {
  if (!sessionId) return;
  state.chatSessionIds[agentId] = sessionId;
  delete state.chatNotices[agentId];
}

function shortSessionId(sessionId) {
  if (!sessionId) return 'No active session';
  return sessionId.length > 18 ? `${sessionId.slice(0, 12)}...${sessionId.slice(-6)}` : sessionId;
}

function startNewChat(agentId = state.selectedAgent) {
  state.chat[agentId] = [];
  state.chatSessionIds[agentId] = newChatSessionId();
  delete state.chatNotices[agentId];
  state.chatAttachments = [];
  saveChat();
  renderAttachmentTray();
  renderChatHeader();
  renderMessages('agentMessages', agentId);
  $('#agentInput')?.focus();
}

async function activeSessionExists(agentId, sessionId) {
  if (!sessionId) return false;
  const data = await api(`/api/sessions?agent=${encodeURIComponent(agentId)}`);
  return (data.sessions || []).some((session) => session.sessionId === sessionId && session.fileExists !== false);
}

async function refreshChatSessionState(agentId = state.selectedAgent) {
  const sessionId = activeChatSessionId(agentId);
  if (!sessionId || !ensureChat(agentId).length) return true;
  try {
    if (await activeSessionExists(agentId, sessionId)) return true;
    state.chat[agentId] = [];
    delete state.chatSessionIds[agentId];
    state.chatNotices[agentId] = `Previous session ${shortSessionId(sessionId)} is no longer available. Start a new chat.`;
    saveChat();
    if (agentId === state.selectedAgent) {
      renderChatHeader();
      renderMessages('agentMessages', agentId);
    }
    return false;
  } catch {
    return true;
  }
}

async function prepareChatSessionForSend(agentId) {
  if (hasDetachedChat(agentId)) {
    state.chat[agentId] = [];
    delete state.chatSessionIds[agentId];
    state.chatNotices[agentId] = 'Old local transcript had no active OpenClaw session, so this message starts a fresh chat.';
  } else {
    await refreshChatSessionState(agentId);
  }
  return ensureChatSessionId(agentId);
}

function renderChatHeader() {
  const agent = state.agents.find((item) => item.id === state.selectedAgent) || state.agents[0] || { id: state.selectedAgent };
  const title = agentLabel(agent);
  const sessionId = activeChatSessionId(state.selectedAgent);
  $('#subagentChatTitle').textContent = title;
  $('#chatAgentMeta').textContent = `${agent.identity?.theme || 'Ready when you are.'} · Session ${shortSessionId(sessionId)}`;
  $('#agentInput').placeholder = `Message ${title}`;
}

function chatGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

async function loadDashboard() {
  try {
    state.dashboard = await api('/api/dashboard');
    renderDashboard();
  } catch (err) {
    $('#metricGrid').innerHTML = `<article class="metric-card"><p class="metric-label">Dashboard error</p><p class="muted">${escapeHtml(err.message)}</p></article>`;
  }
}

function renderDashboard() {
  const dash = state.dashboard || {};
  const metrics = [
    ['Sessions', dash.sessions?.total ?? 0, `${dash.sessions?.downloadable ?? 0} logs`],
    ['Messages', dash.sessions?.downloadable ?? 0, 'downloadable sessions'],
    ['Tasks', dash.tasks?.total ?? state.tasks.length, `${dash.tasks?.running ?? 0} running`],
    ['Agents', dash.agents?.total ?? state.agents.length, 'online roster']
  ];
  $('#metricGrid').innerHTML = metrics.map(([label, value, note]) => `
    <article class="metric-card">
      <p class="metric-label">${label}</p>
      <p class="metric-value">${value}</p>
      <span class="metric-label">${note}</span>
    </article>
  `).join('');

  $('#agentCountBadge').textContent = `${dash.agents?.total ?? state.agents.length} agents`;
  $('#dashboardAgents').innerHTML = state.agents.map((agent) => `
    <div class="mini-row">
      <div class="avatar">${escapeHtml(agentEmoji(agent))}</div>
      <div>
        <strong>${escapeHtml(agentLabel(agent))}</strong>
        <div class="muted">${escapeHtml(agent.id)} · ${escapeHtml(agent.identity?.theme || agent.name || 'agent')}</div>
      </div>
      <span class="pill">${agent.isDefault ? 'main' : 'sub'}</span>
    </div>
  `).join('');

  const recent = dash.sessions?.recent || [];
  $('#recentSessions').innerHTML = recent.length ? recent.map((session) => `
    <button class="mini-row mini-row-button" ${sessionOpenAttrs(session)} type="button">
      <div class="avatar">${escapeHtml(session.agentId.slice(0, 2).toUpperCase())}</div>
      <div>
        <strong>${formatDate(session.startedAt || session.updatedAt)}</strong>
        <div class="muted">${escapeHtml(session.agentId)} · ${escapeHtml(session.kind || 'session')}</div>
      </div>
      <span class="pill">${sessionStatusLabel(session)}</span>
    </button>
  `).join('') : '<p class="muted">No recent sessions.</p>';
  renderSecurityStatus();
  bindSessionOpenButtons();
  loadSidebarSessions();
}

function renderSecurityStatus() {
  const card = $('#securityStatusCard');
  if (!card) return;

  const health = state.health;
  if (!health) {
    card.classList.add('is-warning');
    card.innerHTML = `
      <div class="card-head">
        <div>
          <p class="eyebrow">Local Access</p>
          <h3>Safety Status</h3>
        </div>
        <span class="pill">offline</span>
      </div>
      <div class="security-status-list">
        <p class="muted">Health check is unavailable.</p>
      </div>
    `;
    return;
  }

  const localOnly = health.security?.localOnly !== false;
  const warning = health.security?.warning || '';
  card.classList.toggle('is-warning', !localOnly);
  card.innerHTML = `
    <div class="card-head">
      <div>
        <p class="eyebrow">Local Access</p>
        <h3>Safety Status</h3>
      </div>
      <span class="pill">${localOnly ? 'loopback' : 'review bind'}</span>
    </div>
    <div class="security-status-list">
      <div><span>Bind</span><strong>${escapeHtml(health.network?.host || 'unknown')}:${escapeHtml(String(health.network?.port || ''))}</strong></div>
      <div><span>Mode</span><strong>${health.mock ? 'mock' : 'live'}</strong></div>
      <div><span>Config</span><strong>${escapeHtml(health.config?.file || 'not found')}</strong></div>
      <div><span>Auth</span><strong>${escapeHtml(health.security?.authentication || 'none')}</strong></div>
    </div>
    ${warning ? `<p class="security-warning">${escapeHtml(warning)}</p>` : '<p class="muted">Loopback binding keeps this control panel local to this machine.</p>'}
  `;
}

async function loadSidebarSessions() {
  try {
    const data = await api('/api/sessions/all');
    state.sidebarSessions = data.sessions || [];
    renderSidebarSessions(state.sidebarSessions);
  } catch {
    renderSidebarSessions([]);
  }
}

function renderSidebarSessions(sessions) {
  const target = $('#sidebarSessions');
  if (!target) return;
  $('#sidebarSessionCount').textContent = String(sessions.length || 0);
  target.innerHTML = sessions.length ? sessions.map((session) => `
    <button class="sidebar-session" ${sessionOpenAttrs(session)} type="button">
      <span class="sidebar-session-icon">☰</span>
      <span>
        <span class="sidebar-session-title">${formatDate(session.startedAt || session.updatedAt)}</span>
        <span class="sidebar-session-meta">${escapeHtml(session.agentName || session.agentId)} · ${escapeHtml(session.kind || 'session')} · ${sessionStatusLabel(session)}</span>
      </span>
    </button>
  `).join('') : '<p class="muted" style="padding: 8px 10px;">No sessions yet.</p>';
  bindSessionOpenButtons(target);
}

async function refreshSelectedMemoryFile() {
  if (!state.selectedMemoryPath || $('#memoryEditorForm')?.classList.contains('is-hidden')) return;
  if (!memoryCanAutoRender()) {
    $('#memoryEditorState').textContent = 'External memory update available. Save or discard your edits to refresh.';
    return;
  }
  await openMemoryFile(state.selectedMemoryPath);
  $('#memoryEditorState').textContent = 'updated from disk';
}

async function applySyncChanges(next) {
  const previous = state.sync.versions || {};
  const versions = next.versions || {};
  const changed = (key) => previous[key] && versions[key] && previous[key] !== versions[key];
  const currentTab = activeTab();
  const agentsChanged = changed('agents');
  const skillsChanged = changed('skills');
  const sessionsChanged = changed('sessions');
  const memoryChanged = changed('memory');
  const tasksChanged = changed('tasks');
  const swarmChanged = changed('swarm');

  state.sync.versions = versions;
  state.sync.lastAt = Date.now();

  if (!Object.keys(previous).length) return;

  if (agentsChanged) await loadAgents();
  if (skillsChanged) await loadSkills();

  if (tasksChanged) {
    await loadTasks();
    if (currentTab === 'dashboard') await loadDashboard();
  }

  if (sessionsChanged) {
    await loadSidebarSessions();
    await refreshChatSessionState();
    if (currentTab === 'logs') await loadSessions();
    if (currentTab === 'dashboard') await loadDashboard();
  }

  if (memoryChanged) {
    if (currentTab === 'logs') {
      await loadMemoryFiles();
      await refreshSelectedMemoryFile();
    }
  }

  if ((agentsChanged || sessionsChanged || tasksChanged || swarmChanged) && currentTab === 'swarm') {
    await loadSwarm();
  }

  if ((agentsChanged || sessionsChanged || tasksChanged) && currentTab === 'dashboard') {
    await loadDashboard();
  }
}

async function pollSyncState() {
  if (state.sync.inFlight || document.hidden) return;
  state.sync.inFlight = true;
  try {
    await applySyncChanges(await api('/api/sync-state'));
  } catch {
    // Sync failures should not interrupt the active local workflow.
  } finally {
    state.sync.inFlight = false;
  }
}

function startRealtimeSync() {
  if (state.sync.timer) clearInterval(state.sync.timer);
  pollSyncState();
  state.sync.timer = setInterval(pollSyncState, SYNC_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollSyncState();
  });
  window.addEventListener('focus', pollSyncState);
}

function renderAgents() {
  if (!$('#agentGrid')) return;
  $('#agentGrid').innerHTML = state.agents.map((agent) => `
    <article class="workspace-card agent-card">
      <div class="agent-card-top">
        <div class="avatar">${escapeHtml(agentEmoji(agent))}</div>
        <div>
          <h3>${escapeHtml(agentLabel(agent))}</h3>
          <div class="muted">${escapeHtml(agent.id)} · ${escapeHtml(agent.model || 'model inherited')}</div>
        </div>
      </div>
      <p class="muted">${escapeHtml(shortText(agent.personality || agent.instructions || agent.identity?.theme || 'No local personality summary.', 180))}</p>
      <div class="agent-meta">
        <span class="pill">${agent.skills?.length || 0} skills</span>
        <span class="pill">${Object.keys(agent.tools || {}).length} tool groups</span>
        <span class="pill">${agent.thinkingDefault || 'thinking inherited'}</span>
      </div>
      <div class="agent-actions">
        <button type="button" data-chat-agent="${agent.id}">${agent.id === 'main' ? 'Open Atlas' : 'Chat'}</button>
        <button class="ghost-btn" type="button" data-log-agent="${agent.id}">Logs</button>
        <button class="ghost-btn" type="button" data-config-agent="${agent.id}">Config</button>
      </div>
    </article>
  `).join('');

  $$('[data-chat-agent]').forEach((button) => button.addEventListener('click', () => {
    state.selectedAgent = button.dataset.chatAgent;
    renderAgentOptions();
    renderMessages('agentMessages', state.selectedAgent);
    setActiveTab('chat');
  }));
  $$('[data-log-agent]').forEach((button) => button.addEventListener('click', () => {
    state.selectedSessionAgent = button.dataset.logAgent;
    $('#sessionAgentSelect').value = state.selectedSessionAgent;
    setActiveTab('logs');
  }));
  $$('[data-config-agent]').forEach((button) => button.addEventListener('click', () => {
    state.selectedSettingsAgent = button.dataset.configAgent;
    setActiveTab('settings');
	  }));
	}

async function loadSwarm() {
  const surface = $('#swarmSurface');
  if (surface && !state.swarm.roster.length) {
    surface.innerHTML = '<div class="swarm-empty">Loading OpenClaw swarm...</div>';
  }
  try {
    const [health, roster, runtime, missions, kanban, reports] = await Promise.all([
      api('/api/swarm-health'),
      api('/api/swarm-roster'),
      api('/api/swarm-runtime'),
      api('/api/swarm-missions?limit=50'),
      api('/api/swarm-kanban'),
      api('/api/swarm-reports')
    ]);
    state.swarm.health = health;
    state.swarm.roster = roster.roster?.workers || roster.workers || [];
    state.swarm.runtime = runtime.entries || [];
    state.swarm.tmuxAvailable = Boolean(runtime.tmuxAvailable);
    state.swarm.missions = missions.missions || [];
    state.swarm.cards = kanban.cards || [];
    state.swarm.reports = reports;
    if (!state.swarm.selectedWorker || !state.swarm.roster.find((worker) => worker.id === state.swarm.selectedWorker)) {
      state.swarm.selectedWorker = state.swarm.roster[0]?.id || '';
    }
    renderSwarm();
  } catch (err) {
    $('#swarmSurface').innerHTML = `<div class="swarm-empty">Swarm load failed: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSwarm() {
  const workers = state.swarm.roster;
  if (!workers.length) {
    $('#swarmSurface').innerHTML = '<div class="swarm-empty">No OpenClaw subagents are configured.</div>';
    return;
  }
  const health = state.swarm.health || {};
  const selected = workerById(state.swarm.selectedWorker || workers[0].id);
  const selectedRuntime = runtimeFor(selected.id);
  const activeCount = state.swarm.runtime.filter((entry) => entry.currentTask).length;
  const inbox = state.swarm.reports?.inbox || { needsReview: 0, blocked: 0, ready: 0 };
  const playbook = activeSwarmPlaybook();
  const recommendedIds = availablePlaybookWorkers(playbook);
  const missionIds = missionWorkerIds();
  const missionTeam = missionIds.map(workerById).filter((worker) => worker.id);
  const laneCounts = state.swarm.cards.reduce((counts, card) => {
    const lane = counts[card.status] === undefined ? 'backlog' : card.status;
    counts[lane] = (counts[lane] || 0) + 1;
    return counts;
  }, Object.fromEntries(SWARM_LANES.map(([lane]) => [lane, 0])));
  const playbookButtons = SWARM_PLAYBOOKS.map((item) => `
    <button class="swarm-playbook ${item.id === playbook.id ? 'is-active' : ''}" type="button" data-swarm-playbook="${item.id}">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(item.description)}</span>
    </button>
  `).join('');
  const teamButtons = workers.map((worker) => {
    const selectedForMission = missionIds.includes(worker.id);
    const recommended = recommendedIds.includes(worker.id);
    return `
      <button class="swarm-team-toggle ${selectedForMission ? 'is-active' : ''}" type="button" data-swarm-room="${worker.id}">
        <span class="team-glyph">${escapeHtml(roleGlyph(worker.role))}</span>
        <span>
          <strong>${escapeHtml(worker.displayName || worker.name || worker.id)}</strong>
          <small>${escapeHtml(worker.role || 'Worker')}${recommended ? ' · recommended' : ''}</small>
        </span>
      </button>
    `;
  }).join('');
  const teamSummary = missionTeam.map((worker) => `
    <span class="swarm-chip"><strong>${escapeHtml(roleGlyph(worker.role))}</strong>${escapeHtml(worker.displayName || worker.name || worker.id)}</span>
  `).join('');

  $('#swarmSurface').innerHTML = `
    <div class="swarm-status-strip">
      <div>
        <p class="eyebrow">OpenClaw Swarm</p>
        <h2>Mission Control</h2>
        <p class="muted">Pick a playbook, assign the right specialists, create cards, and run the work from one surface.</p>
      </div>
      <div class="swarm-header-actions">
        <div class="swarm-chip-row">
          <span class="swarm-chip"><strong>${activeCount}</strong> active</span>
          <span class="swarm-chip"><strong>${missionIds.length}</strong> on mission</span>
          <span class="swarm-chip"><strong>${workers.length}</strong> workers</span>
        </div>
        <button id="refreshSwarmBtn" type="button">Refresh</button>
      </div>
    </div>

    <div class="swarm-view-switch" aria-label="Swarm view">
      ${['cards', 'kanban', 'reports', 'runtime'].map((view) => `
        <button type="button" class="${state.swarm.view === view ? 'is-active' : ''}" data-swarm-view="${view}">${view === 'cards' ? 'Control' : view[0].toUpperCase() + view.slice(1)}</button>
      `).join('')}
    </div>

    <div class="swarm-stage">
      <article class="swarm-orchestrator">
        <div class="swarm-orchestrator-main">
          <div>
            <p class="eyebrow">Mission Builder</p>
            <h3>${escapeHtml(playbook.label)}</h3>
            <p class="muted">${escapeHtml(playbook.description)} Model: ${escapeHtml(health.workspaceModel || 'inherited')}</p>
          </div>
          <div class="swarm-playbook-grid">${playbookButtons}</div>
          <div class="swarm-metrics">
            <div class="swarm-metric"><strong>${inbox.ready || 0}</strong><span>ready</span></div>
            <div class="swarm-metric"><strong>${inbox.needsReview || 0}</strong><span>review</span></div>
            <div class="swarm-metric"><strong>${inbox.blocked || 0}</strong><span>blocked</span></div>
          </div>
        </div>

        <form id="swarmDecomposeForm" class="swarm-mission-form">
          <label for="swarmGoal">Mission goal</label>
          <textarea id="swarmGoal" placeholder="Example: Fix the chat page bug, verify it, and summarize what changed."></textarea>
          <div class="swarm-team-head">
            <span>Mission team</span>
            <button class="ghost-btn" type="button" data-swarm-recommended>Use recommended</button>
          </div>
          <div class="swarm-team-grid">${teamButtons}</div>
          <div class="swarm-form-grid">
            <select id="swarmPriority" aria-label="Mission priority">
              <option value="normal">Normal priority</option>
              <option value="high">High priority</option>
              <option value="urgent">Urgent priority</option>
              <option value="low">Low priority</option>
            </select>
            <button type="submit">Create Mission Cards</button>
          </div>
        </form>
      </article>

      <article class="swarm-selected-card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Mission Team</p>
            <h3>${missionTeam.length} specialists</h3>
          </div>
          <span class="worker-status ${workerStatusClass(selected, selectedRuntime)}">${escapeHtml(playbook.id)}</span>
        </div>
        <p>${escapeHtml(playbook.description)}</p>
        <div class="swarm-team-summary">${teamSummary || '<span class="muted">No workers selected.</span>'}</div>
        <div class="swarm-selected-meta">
          <span class="pill">${escapeHtml(selected.displayName || selected.name || selected.id)} selected</span>
          <span class="pill">${selected.assignedTaskCount || 0} tasks</span>
          <span class="pill">${selected.cronJobCount || 0} cron</span>
        </div>
        <div class="swarm-worker-actions">
          <button type="button" data-swarm-chat="${selected.id}">Chat</button>
          <button class="ghost-btn" type="button" data-swarm-recommended>Recommended</button>
          <button class="ghost-btn" type="button" data-swarm-tasks="${selected.id}">Tasks</button>
        </div>
      </article>

      <article class="swarm-results-card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Mission Inbox</p>
            <h3>Dispatch Log</h3>
          </div>
          <span class="pill">${state.swarm.cards.length} cards</span>
        </div>
        <div class="swarm-lane-mini">
          ${SWARM_LANES.map(([lane, label]) => `<span><strong>${laneCounts[lane] || 0}</strong>${label}</span>`).join('')}
        </div>
        <pre id="swarmRouterResults" class="swarm-router-results">${escapeHtml(state.swarm.dispatchLog || 'Router results and mission creation status appear here.')}</pre>
        <form id="swarmRouterForm" class="swarm-router-form compact">
          <label for="swarmPrompt">Quick team message</label>
          <textarea id="swarmPrompt" placeholder="Send a short instruction to the selected mission team."></textarea>
          <div class="swarm-mode-toggle" role="radiogroup" aria-label="Dispatch mode">
            <label><input type="radio" name="swarmMode" value="manual" checked><span>Team</span></label>
            <label><input type="radio" name="swarmMode" value="auto"><span>Auto</span></label>
            <label><input type="radio" name="swarmMode" value="broadcast"><span>All</span></label>
          </div>
          <button class="ghost-btn" type="submit">Send Message</button>
        </form>
      </article>
    </div>

    <div class="swarm-workspace">
      <div class="swarm-workers-wrap">
        ${renderSwarmActiveView(workers)}
      </div>
    </div>
  `;

  bindSwarmEvents();
}

function renderSwarmActiveView(workers) {
  if (state.swarm.view === 'kanban') return renderSwarmBoard();
  if (state.swarm.view === 'reports') return renderSwarmReports();
  if (state.swarm.view === 'runtime') return renderSwarmRuntime();
  return `<div class="swarm-worker-grid">${workers.map(renderSwarmWorkerCard).join('')}</div>`;
}

function renderSwarmWorkerCard(worker) {
  const runtime = runtimeFor(worker.id);
  const isSelected = worker.id === state.swarm.selectedWorker;
  const inRoom = state.swarm.roomIds.includes(worker.id);
  const recent = runtime.recentLogTail || runtime.lastSummary || 'No recent runtime output.';
  return `
    <article class="swarm-worker-card ${isSelected ? 'is-selected' : ''} ${inRoom ? 'in-room' : ''}" data-worker-card="${worker.id}">
      <div class="swarm-worker-head">
        <div class="worker-avatar">${escapeHtml(roleGlyph(worker.role))}</div>
        <div>
          <h3>${escapeHtml(worker.displayName || worker.name || worker.id)}</h3>
          <div class="muted">${escapeHtml(worker.role || 'Worker')} · ${escapeHtml(worker.model || 'model inherited')}</div>
        </div>
        <span class="worker-status ${workerStatusClass(worker, runtime)}">${escapeHtml(worker.currentLane || worker.status || 'ready')}</span>
      </div>

      <p class="muted">${escapeHtml(shortText(worker.mission, 180))}</p>

      <div class="swarm-focus-panel">
        <strong>${escapeHtml(worker.currentTask || 'Ready for task')}</strong>
        <span class="muted">${worker.assignedTaskCount || 0} active lanes · ${worker.cronJobCount || 0} cron lanes</span>
        <span class="muted">Capabilities: ${escapeHtml((worker.capabilities || []).slice(0, 4).join(', ') || 'direct-chat')}</span>
      </div>

      <details class="swarm-output-drawer">
        <summary>Recent output</summary>
        <pre class="swarm-signal">${escapeHtml(recent)}</pre>
      </details>

      <div class="swarm-worker-actions">
        <button type="button" data-swarm-select="${worker.id}">Select</button>
        <button class="ghost-btn" type="button" data-swarm-room="${worker.id}">${inRoom ? 'Remove' : 'Mission'}</button>
        <button class="ghost-btn" type="button" data-swarm-chat="${worker.id}">Chat</button>
        <button class="ghost-btn" type="button" data-swarm-tasks="${worker.id}">Tasks</button>
      </div>
    </article>
  `;
}

function renderSwarmBoard() {
  const groups = Object.fromEntries(SWARM_LANES.map(([lane]) => [lane, []]));
  state.swarm.cards.forEach((card) => {
    const lane = groups[card.status] ? card.status : 'backlog';
    groups[lane].push(card);
  });
  return `
    <section class="swarm-view-panel">
      <div class="card-head">
        <div>
          <p class="eyebrow">Manual planning</p>
          <h3>Swarm Board</h3>
        </div>
        <span class="pill">${state.swarm.cards.length} cards</span>
      </div>
      <div class="swarm-board">
        ${SWARM_LANES.map(([lane, label]) => `
          <section class="swarm-board-lane" data-swarm-lane="${lane}">
            <div class="column-head">
              <div class="column-title"><span class="column-dot"></span>${label}</div>
              <span class="pill">${groups[lane].length}</span>
            </div>
            ${groups[lane].map(renderSwarmBoardCard).join('') || '<p class="muted" style="padding: 10px;">No cards.</p>'}
          </section>
        `).join('')}
      </div>
    </section>
  `;
}

function renderSwarmBoardCard(card) {
  const worker = workerById(card.assignedWorker || '');
  const canRun = !['running', 'done'].includes(card.status);
  return `
    <article class="swarm-board-card" draggable="true" data-swarm-card="${card.id}">
      <div class="swarm-board-card-head">
        <strong>${escapeHtml(card.title)}</strong>
        <span class="badge ${escapeHtml(card.priority || 'normal')}">${escapeHtml(card.priority || 'normal')}</span>
      </div>
      <span class="muted">${escapeHtml(shortText(card.spec, 150))}</span>
      <div class="swarm-card-meta">
        <span class="pill">${escapeHtml(worker.displayName || worker.name || card.assignedWorker || 'unassigned')}</span>
        ${card.reviewer ? `<span class="pill">review ${escapeHtml(card.reviewer)}</span>` : ''}
      </div>
      ${card.result ? `<div class="swarm-card-result">${escapeHtml(shortText(card.result, 220))}</div>` : ''}
      ${card.error ? `<div class="swarm-card-result is-error">${escapeHtml(shortText(card.error, 220))}</div>` : ''}
      <div class="swarm-card-actions">
        <button type="button" data-swarm-run="${card.id}" ${canRun ? '' : 'disabled'}>${card.status === 'done' ? 'Done' : card.status === 'running' ? 'Running' : 'Run'}</button>
        <button class="ghost-btn" type="button" data-swarm-chat="${card.assignedWorker || 'main'}">Chat</button>
      </div>
    </article>
  `;
}

function renderSwarmReports() {
  const missions = state.swarm.missions || [];
  const inbox = state.swarm.reports?.inbox || { needsReview: 0, blocked: 0, ready: 0 };
  return `
    <section class="swarm-view-panel">
      <div class="card-head">
        <div>
          <p class="eyebrow">Inbox</p>
          <h3>Reports</h3>
        </div>
        <div class="swarm-chip-row">
          <span class="swarm-chip"><strong>${inbox.needsReview || 0}</strong> review</span>
          <span class="swarm-chip"><strong>${inbox.blocked || 0}</strong> blocked</span>
          <span class="swarm-chip"><strong>${inbox.ready || 0}</strong> ready</span>
        </div>
      </div>
      <div class="swarm-inbox-grid">
        ${missions.slice(0, 9).map((mission) => `
          <article class="swarm-report-card">
            <strong>${escapeHtml(shortText(mission.title, 80))}</strong>
            <p class="muted">${escapeHtml(mission.state)} · ${(mission.assignments || []).length} assignments</p>
            <p class="muted">${formatDate(mission.updatedAt)}</p>
          </article>
        `).join('') || '<p class="muted">No mission reports yet.</p>'}
      </div>
    </section>
  `;
}

function renderSwarmRuntime() {
  return `
    <section class="swarm-view-panel">
      <div class="card-head">
        <div>
          <p class="eyebrow">Runtime</p>
          <h3>Worker Outputs</h3>
        </div>
        <span class="pill">tmux ${state.swarm.tmuxAvailable ? 'available' : 'not attached'}</span>
      </div>
      <div class="runtime-grid">
        ${state.swarm.runtime.map((entry) => `
          <article class="runtime-card">
            <strong>${escapeHtml(entry.displayName || entry.workerId)}</strong>
            <p class="muted">${escapeHtml(entry.phase || entry.checkpointStatus || 'idle')} · ${formatDate(entry.lastOutputAt)}</p>
            <pre>${escapeHtml(entry.recentLogTail || entry.currentTask || 'No runtime output yet.')}</pre>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function bindSwarmEvents() {
  $('#refreshSwarmBtn')?.addEventListener('click', loadSwarm);
  $$('[data-swarm-view]').forEach((button) => button.addEventListener('click', () => {
    state.swarm.view = button.dataset.swarmView;
    saveSwarmPrefs();
    renderSwarm();
  }));
  $$('[data-swarm-playbook]').forEach((button) => button.addEventListener('click', () => {
    state.swarm.playbook = button.dataset.swarmPlaybook || 'build';
    setRecommendedSwarmTeam();
    saveSwarmPrefs();
    renderSwarm();
  }));
  $$('[data-swarm-recommended]').forEach((button) => button.addEventListener('click', () => {
    setRecommendedSwarmTeam();
    saveSwarmPrefs();
    renderSwarm();
  }));
  $$('[data-swarm-select]').forEach((button) => button.addEventListener('click', () => {
    state.swarm.selectedWorker = button.dataset.swarmSelect;
    saveSwarmPrefs();
    renderSwarm();
  }));
  $$('[data-swarm-room]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.swarmRoom;
    state.swarm.roomIds = state.swarm.roomIds.includes(id)
      ? state.swarm.roomIds.filter((item) => item !== id)
      : [...state.swarm.roomIds, id];
    state.swarm.selectedWorker = id;
    saveSwarmPrefs();
    renderSwarm();
  }));
  $$('[data-swarm-chat]').forEach((button) => button.addEventListener('click', () => {
    state.selectedAgent = button.dataset.swarmChat;
    renderAgentOptions();
    renderMessages('agentMessages', state.selectedAgent);
    setActiveTab('chat');
  }));
  $$('[data-swarm-tasks]').forEach((button) => button.addEventListener('click', () => {
    state.swarm.selectedWorker = button.dataset.swarmTasks;
    saveSwarmPrefs();
    setActiveTab('tasks');
  }));
  $('#swarmRouterForm')?.addEventListener('submit', dispatchSwarm);
  $('#swarmDecomposeForm')?.addEventListener('submit', decomposeSwarm);
  $$('[data-swarm-run]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Running';
    await runTask(button.dataset.swarmRun);
  }));
  bindSwarmBoardDrag();
}

function selectedSwarmWorkers() {
  return missionWorkerIds();
}

async function dispatchSwarm(event) {
  event.preventDefault();
  const prompt = $('#swarmPrompt').value.trim();
  if (!prompt) return;
  $('#swarmRouterResults').textContent = 'dispatching...';
  try {
    const result = await api('/api/swarm-dispatch', {
      method: 'POST',
      body: {
        message: prompt,
        mode: $('[name="swarmMode"]:checked')?.value || 'manual',
        workerIds: selectedSwarmWorkers()
      }
    });
    state.swarm.dispatchLog = result.results.map((item) => {
      if (!item.ok) return `${item.workerId}: ${item.error}`;
      return `${item.workerId}: ${shortText(item.text || '(no text)', 520)}`;
    }).join('\n\n') || 'No dispatch result.';
    $('#swarmPrompt').value = '';
    await loadSwarm();
  } catch (err) {
    state.swarm.dispatchLog = err.message;
    $('#swarmRouterResults').textContent = err.message;
  }
}

async function decomposeSwarm(event) {
  event.preventDefault();
  const goal = $('#swarmGoal').value.trim();
  if (!goal) return;
  $('#swarmRouterResults').textContent = 'creating mission cards...';
  try {
    const result = await api('/api/swarm-decompose', {
      method: 'POST',
      body: {
        goal,
        playbook: state.swarm.playbook,
        workerIds: selectedSwarmWorkers(),
        priority: $('#swarmPriority')?.value || 'normal',
        column: 'todo'
      }
    });
    state.swarm.dispatchLog = [
      `Created ${result.cards.length} ${result.playbook?.label || 'mission'} cards.`,
      `Mission ${result.mission.id}`,
      '',
      ...result.cards.map((card) => `${card.assignedWorker || 'unassigned'} -> ${card.title}`)
    ].join('\n');
    $('#swarmGoal').value = '';
    state.swarm.view = 'kanban';
    saveSwarmPrefs();
    await loadTasks();
    await loadDashboard();
    await loadSwarm();
  } catch (err) {
    state.swarm.dispatchLog = err.message;
    $('#swarmRouterResults').textContent = err.message;
  }
}

function bindSwarmBoardDrag() {
  $$('.swarm-board-lane').forEach((lane) => {
    lane.addEventListener('dragover', (event) => {
      event.preventDefault();
      lane.classList.add('drag-over');
    });
    lane.addEventListener('dragleave', () => lane.classList.remove('drag-over'));
    lane.addEventListener('drop', async (event) => {
      event.preventDefault();
      lane.classList.remove('drag-over');
      const id = event.dataTransfer.getData('text/plain');
      if (!id) return;
      await api('/api/swarm-kanban', { method: 'PATCH', body: { id, status: lane.dataset.swarmLane } });
      await loadTasks();
      await loadDashboard();
      await loadSwarm();
    });
  });
  $$('[data-swarm-card]').forEach((card) => {
    card.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', card.dataset.swarmCard));
  });
}

function ensureChat(agentId) {
  state.chat[agentId] ||= [];
  return state.chat[agentId];
}

function renderChatMessage(message, agent) {
  const isMe = message.role === 'me' || message.role === 'user';
  const label = isMe ? 'You' : escapeHtml(agentLabel(agent));
  const stateClass = message.status === 'streaming' ? 'is-streaming' : message.status === 'error' ? 'is-error' : '';
  return `
    <div class="message ${escapeHtml(message.role || 'agent')} ${stateClass}">
      <span class="meta">${label}${message.status ? ` · ${escapeHtml(message.status)}` : ''}</span>
      ${message.text ? `<div class="message-text">${renderRichText(message.text)}</div>` : ''}
      ${!message.text && message.status === 'streaming' ? '<div class="message-streaming"><span></span><span></span><span></span></div>' : ''}
      ${renderMessageAttachments(message.attachments || [])}
      ${!isMe ? renderRunActivity(message) : ''}
    </div>
  `;
}

function renderMessages(elementId, agentId) {
  const log = $(`#${elementId}`);
  if (!log) return;
  const messages = ensureChat(agentId);
  const agent = state.agents.find((item) => item.id === agentId) || { id: agentId };
  $('.chat-window')?.classList.toggle('is-empty', messages.length === 0);
  if (!messages.length) {
    const notice = state.chatNotices[agentId]
      ? `<div class="chat-session-warning">${escapeHtml(state.chatNotices[agentId])}</div>`
      : '';
    log.innerHTML = `
      ${notice}
      <div class="chat-empty-state">
        <div class="chat-greeting-mark">${escapeHtml(agentEmoji(agent))}</div>
        <h2>${chatGreeting()}</h2>
        <p>Chat with ${escapeHtml(agentLabel(agent))}</p>
      </div>
    `;
    return;
  }
  const detachedWarning = hasDetachedChat(agentId)
    ? `<div class="chat-session-warning">This saved transcript is not attached to an active OpenClaw session. Sending will start a fresh chat.</div>`
    : '';
  log.innerHTML = `${detachedWarning}${messages.map((message) => renderChatMessage(message, agent)).join('')}`;
  log.scrollTop = log.scrollHeight;
}

async function sendMessage(agentId, text, form, input, logId) {
  const attachments = [...(state.chatAttachments || [])];
  const visibleText = text.trim();
  if (!visibleText && !attachments.length) return;
  const message = buildChatPrompt(visibleText, attachments);
  const sessionId = await prepareChatSessionForSend(agentId);
  renderChatHeader();
  const chat = ensureChat(agentId);
  chat.push({
    role: 'me',
    text: visibleText || 'Attached files',
    attachments,
    at: new Date().toISOString(),
    sessionId
  });
  const reply = {
    role: 'agent',
    text: '',
    at: new Date().toISOString(),
    sessionId,
    status: 'streaming',
    events: [{ kind: 'status', label: 'Run', text: `Continuing session ${shortSessionId(sessionId)}` }]
  };
  chat.push(reply);
  state.chatAttachments = [];
  input.value = '';
  renderAttachmentTray();
  saveChat();
  renderMessages(logId, agentId);
  setBusy(form, true);
  try {
    await streamApi('/api/chat/stream', { agentId, message, sessionId }, {
      status: (event) => {
        reply.status = 'streaming';
        if (event.sessionId) {
          reply.sessionId = event.sessionId;
          setActiveChatSessionId(agentId, event.sessionId);
          renderChatHeader();
        }
        appendMessageEvent(reply, { kind: 'status', label: 'Run', text: event.text || event.status || 'Running' });
        saveChat();
        renderMessages(logId, agentId);
      },
      activity: (event) => {
        appendMessageEvent(reply, event);
        saveChat();
        renderMessages(logId, agentId);
      },
      final: (result) => {
        reply.role = 'agent';
        reply.text = result.text || '(no text response)';
        reply.at = new Date().toISOString();
        reply.runId = result.runId;
        reply.sessionId = result.sessionId || reply.sessionId || sessionId;
        setActiveChatSessionId(agentId, reply.sessionId);
        reply.status = result.status || 'ok';
        reply.raw = result.raw;
        collectRunItems(result.raw).forEach((item) => appendMessageEvent(reply, item));
        renderChatHeader();
        saveChat();
        renderMessages(logId, agentId);
      },
      error: (event) => {
        reply.status = 'error';
        reply.text = `Error: ${event.error || event.message || 'stream failed'}`;
        appendMessageEvent(reply, { kind: 'error', label: 'Error', text: event.error || event.message || 'stream failed' });
        saveChat();
        renderMessages(logId, agentId);
      }
    });
  } catch (err) {
    reply.status = 'error';
    reply.text = `Error: ${err.message}`;
    appendMessageEvent(reply, { kind: 'error', label: 'Error', text: err.message });
  } finally {
    setBusy(form, false);
    saveChat();
    renderMessages(logId, agentId);
    input.focus();
    loadDashboard();
  }
}

async function loadTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks || [];
  state.taskSettings = data.settings || { mode: 'priority', autoRun: false };
  $('#taskMode').value = state.taskSettings.mode || 'priority';
  $('#taskAuto').checked = Boolean(state.taskSettings.autoRun);
  renderTasks();
}

function sortedTasksForColumn(column) {
  return state.tasks
    .filter((task) => (task.column || columnFromStatus(task.status)) === column)
    .sort((a, b) => {
      if ((state.taskSettings.mode || 'priority') === 'priority') {
        return (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0)
          || String(a.dueAt || a.createdAt).localeCompare(String(b.dueAt || b.createdAt));
      }
      return String(a.dueAt || a.createdAt).localeCompare(String(b.dueAt || b.createdAt))
        || (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0);
    });
}

function columnFromStatus(status) {
  if (status === 'running') return 'in_progress';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'blocked';
  return 'backlog';
}

function renderTasks() {
  const total = state.tasks.length;
  const running = state.tasks.filter((task) => (task.column || columnFromStatus(task.status)) === 'in_progress' || task.status === 'running').length;
  const done = state.tasks.filter((task) => (task.column || columnFromStatus(task.status)) === 'done' || task.status === 'done').length;
  const blocked = state.tasks.filter((task) => (task.column || columnFromStatus(task.status)) === 'blocked' || task.status === 'failed').length;
  const stats = $('#taskStats');
  if (stats) stats.textContent = `${total} total · ${running} running · ${done} done · ${blocked} blocked`;
  $('#taskBoard').innerHTML = COLUMNS.map(([column, label]) => {
    const tasks = sortedTasksForColumn(column);
    return `
      <section class="kanban-column" data-column="${column}">
        <div class="column-head">
          <div class="column-title"><span class="column-dot column-dot-${column}"></span>${label}</div>
          <span class="pill">${tasks.length}</span>
        </div>
        <div class="column-body">
          ${tasks.map(renderTaskCard).join('') || `<div class="kanban-empty"><span>☑</span><strong>No cards</strong><p>Drop here or add a task.</p></div>`}
        </div>
      </section>
    `;
  }).join('');

  $$('.kanban-column').forEach((columnEl) => {
    columnEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      columnEl.classList.add('drag-over');
    });
    columnEl.addEventListener('dragleave', () => columnEl.classList.remove('drag-over'));
    columnEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      columnEl.classList.remove('drag-over');
      const taskId = event.dataTransfer.getData('text/plain');
      if (taskId) await patchTask(taskId, { column: columnEl.dataset.column });
    });
  });
  $$('[draggable="true"]').forEach((card) => {
    card.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', card.dataset.taskId));
  });
  $$('[data-task-run]').forEach((button) => button.addEventListener('click', () => runTask(button.dataset.taskRun)));
  $$('[data-task-delete]').forEach((button) => button.addEventListener('click', () => deleteTask(button.dataset.taskDelete)));
  $$('[data-task-move]').forEach((select) => select.addEventListener('change', () => patchTask(select.dataset.taskMove, { column: select.value })));
}

function renderTaskCard(task) {
  const col = task.column || columnFromStatus(task.status);
  const assignee = task.assignee || task.reviewer || task.createdBy || 'Atlas';
  const dueText = task.dueAt ? `Due ${formatDate(task.dueAt)}` : 'No due date';
  return `
    <article class="task-item" draggable="true" data-task-id="${task.id}">
      <div class="task-top">
        <div>
          <div class="task-title">${escapeHtml(task.title)}</div>
          <div class="muted">${escapeHtml(shortText(task.details, 180))}</div>
        </div>
        <span class="badge ${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span>
      </div>
      <div class="task-meta-row">
        <span>${escapeHtml(task.status)}</span>
        <span>${escapeHtml(taskLaneLabel(col))}</span>
        <span>${escapeHtml(assignee)}</span>
      </div>
      <div class="muted">${escapeHtml(dueText)}</div>
      ${task.result ? `<div class="task-result">${escapeHtml(shortText(task.result, 260))}</div>` : ''}
      ${task.error ? `<div class="task-result">${escapeHtml(task.error)}</div>` : ''}
      <div class="task-actions">
        <button type="button" data-task-run="${task.id}" ${task.status === 'running' ? 'disabled' : ''}>Run</button>
        <select class="move-select" data-task-move="${task.id}" aria-label="Move task">
          ${COLUMNS.map(([value, label]) => `<option value="${value}" ${value === col ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="ghost-btn" type="button" data-task-delete="${task.id}">Delete</button>
      </div>
    </article>
  `;
}

async function runTask(id) {
  const queueState = $('#queueState');
  if (queueState) queueState.textContent = 'running task';
  await api(`/api/tasks/${id}/run`, { method: 'POST' });
  if (queueState) queueState.textContent = 'task complete';
  await loadTasks();
  await loadDashboard();
  if (activeTab() === 'swarm') await loadSwarm();
}

async function patchTask(id, patch) {
  await api(`/api/tasks/${id}`, { method: 'PATCH', body: patch });
  await loadTasks();
  await loadDashboard();
}

async function deleteTask(id) {
  await api(`/api/tasks/${id}`, { method: 'DELETE' });
  await loadTasks();
  await loadDashboard();
}

async function saveTaskSettings() {
  await api('/api/tasks/settings', {
    method: 'POST',
    body: {
      mode: $('#taskMode').value,
      autoRun: $('#taskAuto').checked
    }
  });
  await loadTasks();
}

async function loadSessions() {
  const agentId = state.pendingSessionPreview?.agentId || $('#sessionAgentSelect').value || state.selectedSessionAgent || 'all';
  state.selectedSessionAgent = agentId;
  $('#sessionAgentSelect').value = agentId === 'all' ? 'all' : agentId;
  $('#exportAgentLink').classList.toggle('is-disabled', agentId === 'all');
  $('#exportAgentLink').href = agentId === 'all' ? '#' : `/api/sessions/${encodeURIComponent(agentId)}/export`;
  const data = agentId === 'all'
    ? await api('/api/sessions/all')
    : await api(`/api/sessions?agent=${encodeURIComponent(agentId)}`);
  state.sessions = sortByRecent((data.sessions || []).map((session) => ({ ...session, agentId: session.agentId || agentId })), 'startedAt');
  const pending = state.pendingSessionPreview;
  if (pending?.sessionId) {
    const pendingIndex = state.sessions.findIndex((session) => session.agentId === pending.agentId && session.sessionId === pending.sessionId);
    if (pendingIndex >= 0) state.sessionPage = Math.floor(pendingIndex / MEMORY_PAGE_SIZE) + 1;
  }
  renderSessionList();
  if (state.memoryView === 'files') $('#sessionList').classList.add('is-hidden');
  state.pendingSessionPreview = null;
  if (pending?.sessionId) await previewSession(pending.agentId, pending.sessionId);
  await loadMemoryFiles();
}

function renderSessionList() {
  const paged = pageItems(state.sessions, state.sessionPage);
  state.sessionPage = paged.page;
  $('#sessionList').innerHTML = paged.items.map((session) => `
    <article class="workspace-card session-item">
      <div class="session-top">
        <div>
          <div class="session-title">${formatDate(session.startedAt || session.updatedAt)}</div>
          <div class="muted">${escapeHtml(session.agentName || session.agentId)} · ${escapeHtml(session.kind)} · ${session.totalTokens || 'unknown'} tokens</div>
        </div>
        <span class="badge ${sessionStatusClass(session)}">${sessionStatusLabel(session)}</span>
      </div>
      <div class="session-actions">
        <button class="ghost-btn" type="button" data-session-preview ${sessionDataAttrs(session)} ${session.fileExists ? '' : 'disabled'}>Preview</button>
        <a class="download-btn" href="/api/sessions/${encodeURIComponent(session.agentId)}/${encodeURIComponent(session.sessionId)}/download" ${session.fileExists ? '' : 'aria-disabled="true"'}>Download</a>
      </div>
    </article>
  `).join('') || '<p class="muted">No sessions found.</p>';
  $('#sessionList').insertAdjacentHTML('beforeend', renderPager('sessions', paged.page, paged.totalPages, state.sessions.length));

  $$('[data-session-preview]').forEach((button) => {
    button.addEventListener('click', () => {
      previewSession(button.dataset.sessionAgent, button.dataset.sessionId);
    });
  });
  bindPager($('#sessionList'));
}

async function previewSession(agentId, sessionId) {
  const data = await api(`/api/sessions/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}/preview`);
  $('#sessionPreview').classList.remove('is-hidden');
  $('#memoryEditorForm')?.classList.add('is-hidden');
  $('#sessionPreview').innerHTML = `
    <div class="preview-head">
      <strong>${escapeHtml(agentId)} · ${escapeHtml(sessionId)}</strong>
      <span>${data.sizeBytes || 0} bytes</span>
    </div>
    <div class="formatted-log">
      ${(data.messages || []).map((message) => `
        <article class="log-message ${roleClass(message.role)}">
          <span>${escapeHtml(message.label || message.role)}</span>
          <p>${escapeHtml(message.text)}</p>
        </article>
      `).join('') || '<p class="muted">No readable messages in this log.</p>'}
    </div>
  `;
}

function bindSessionOpenButtons(root = document) {
  $$('[data-open-session]', root).forEach((button) => {
    button.addEventListener('click', () => {
      const agentId = button.dataset.sessionAgent;
      const sessionId = button.dataset.sessionId;
      if (!agentId || !sessionId) return;
      state.pendingSessionPreview = { agentId, sessionId };
      state.selectedSessionAgent = agentId;
      setActiveTab('logs');
    });
  });
}

async function loadMemoryFiles() {
  try {
    const agent = $('#sessionAgentSelect')?.value || state.selectedMemoryAgent || 'all';
    state.selectedMemoryAgent = agent;
    const data = await api(`/api/memory-files?agent=${encodeURIComponent(agent)}`);
    state.memoryFiles = sortByRecent(data.files || [], 'updatedAt');
    renderMemoryFiles();
  } catch (err) {
    $('#memoryFileList').innerHTML = `<p class="muted">Memory load failed: ${escapeHtml(err.message)}</p>`;
  }
}

function renderMemoryFiles() {
  const paged = pageItems(state.memoryFiles, state.memoryFilePage);
  state.memoryFilePage = paged.page;
  $('#memoryFileList').innerHTML = paged.items.map((file) => `
    <button class="memory-file-item" data-memory-path="${escapeHtml(file.path)}" type="button">
      <strong>${escapeHtml(file.path)}</strong>
      <span>${formatDate(file.updatedAt)} · ${file.sizeBytes} bytes</span>
    </button>
  `).join('') || '<p class="muted">No memory files found.</p>';
  $('#memoryFileList').insertAdjacentHTML('beforeend', renderPager('files', paged.page, paged.totalPages, state.memoryFiles.length));
  $$('[data-memory-path]').forEach((button) => {
    button.addEventListener('click', () => openMemoryFile(button.dataset.memoryPath));
  });
  bindPager($('#memoryFileList'));
}

async function openMemoryFile(filePath) {
  if (!memoryCanAutoRender() && state.selectedMemoryPath && state.selectedMemoryPath !== filePath) {
    $('#memoryEditorState').textContent = 'Unsaved edits are open. Save or clear them before switching files.';
    return;
  }
  const data = await api(`/api/memory-file?path=${encodeURIComponent(filePath)}`);
  state.selectedMemoryPath = data.path;
  $('#memoryEditorTitle').textContent = data.path;
  $('#memoryEditorText').value = data.content || '';
  $('#memoryEditorState').textContent = '';
  $('#sessionPreview')?.classList.add('is-hidden');
  $('#memoryEditorForm').classList.remove('is-hidden');
  markFormClean('#memoryEditorForm');
}

async function saveMemoryFile(event) {
  event.preventDefault();
  if (!state.selectedMemoryPath) return;
  $('#memoryEditorState').textContent = 'saving';
  const result = await api('/api/memory-file', {
    method: 'PUT',
    body: { path: state.selectedMemoryPath, content: $('#memoryEditorText').value }
  });
  $('#memoryEditorState').textContent = result.ok ? 'saved' : 'not saved';
  markFormClean('#memoryEditorForm');
  await loadMemoryFiles();
}

function renderSettings() {
  const agent = state.agents.find((item) => item.id === state.selectedSettingsAgent) || state.agents[0];
  if (!agent) return;
  if (!settingsCanAutoRender()) {
    $('#settingsState').textContent = 'External update available. Save or switch agents to refresh.';
    return;
  }
  state.selectedSettingsAgent = agent.id;
  $('#settingsAgentSelect').value = agent.id;
  $('#settingsName').value = agent.identity?.name || agent.name || agent.id;
  $('#settingsModel').value = agent.model || '';
  $('#settingsThinking').value = agent.thinkingDefault || '';
  $('#settingsFastMode').value = agent.fastModeDefault ? 'true' : 'false';
  const selected = new Set(agent.skills || []);
  $('#settingsSkills').innerHTML = state.skillCatalog.map((skill) => `
    <label class="skill-check">
      <input type="checkbox" value="${escapeHtml(skill.id)}" ${selected.has(skill.id) ? 'checked' : ''}>
      <span>
        <strong>${escapeHtml(skill.name)}</strong>
        <small>${escapeHtml(skill.installed ? 'installed' : 'configured')}${skill.summary ? ` · ${escapeHtml(skill.summary)}` : ''}</small>
      </span>
    </label>
  `).join('') || '<p class="muted">No skills found.</p>';
  $('#settingsTools').value = JSON.stringify(agent.tools || {}, null, 2);
  $('#settingsPersonality').value = agent.personality || '';
  $('#settingsInstructions').value = agent.instructions || '';
  $('#settingsState').textContent = '';
  markFormClean('#settingsForm');
}

async function saveSettings(event) {
  event.preventDefault();
  const agentId = state.selectedSettingsAgent;
  $('#settingsState').textContent = 'saving';
  try {
    const result = await api(`/api/config/${encodeURIComponent(agentId)}`, {
      method: 'POST',
      body: {
        name: $('#settingsName').value,
        model: $('#settingsModel').value,
        thinkingDefault: $('#settingsThinking').value,
        fastModeDefault: $('#settingsFastMode').value === 'true',
        skills: $$('#settingsSkills input[type="checkbox"]:checked').map((item) => item.value),
        tools: $('#settingsTools').value,
        identity: { name: $('#settingsName').value },
        personality: $('#settingsPersonality').value,
        instructions: $('#settingsInstructions').value
      }
    });
    const idx = state.agents.findIndex((agent) => agent.id === agentId);
    if (idx >= 0) state.agents[idx] = result.agent;
    $('#settingsState').textContent = 'saved';
    markFormClean('#settingsForm');
    renderAgentOptions();
    renderAgents();
    renderDashboard();
  } catch (err) {
    $('#settingsState').textContent = err.message;
  }
}

function setMemoryView(view) {
  state.memoryView = view === 'files' ? 'files' : 'sessions';
  $$('[data-memory-view]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.memoryView === state.memoryView);
  });
  $('#sessionList')?.classList.toggle('is-hidden', state.memoryView !== 'sessions');
  $('#memoryFileList')?.classList.toggle('is-hidden', state.memoryView !== 'files');
  $('#sessionPreview')?.classList.toggle('is-hidden', state.memoryView !== 'sessions');
  if (state.memoryView === 'sessions') $('#memoryEditorForm')?.classList.add('is-hidden');
  if (state.memoryView === 'files') loadMemoryFiles();
}

function setModal(id, open) {
  const modal = $(`#${id}`);
  if (!modal) return;
  modal.classList.toggle('is-hidden', !open);
  if (open) {
    const focusable = $('input, select, textarea, button', modal);
    setTimeout(() => focusable?.focus(), 0);
  }
}

function setSidebarCollapsed(collapsed) {
  $('.workspace-shell')?.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('ocui.sidebarCollapsed', collapsed ? '1' : '0');
  if ($('#collapseSidebarBtn')) {
    $('#collapseSidebarBtn').textContent = collapsed ? '›' : '‹';
    $('#collapseSidebarBtn').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    $('#collapseSidebarBtn').setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }
}

async function runSessionSearch(event) {
  event.preventDefault();
  const query = $('#searchInput').value.trim();
  if (!query) {
    $('#searchResults').innerHTML = '<p class="muted">Type something to search session logs.</p>';
    return;
  }
  $('#searchResults').innerHTML = '<p class="muted">Searching...</p>';
  try {
    const data = await api(`/api/search-sessions?q=${encodeURIComponent(query)}`);
    const results = data.results || [];
    $('#searchResults').innerHTML = results.length ? results.map((result) => `
      <button class="search-result" ${sessionOpenAttrs(result)} type="button">
        <strong>${formatDate(result.startedAt || result.updatedAt)}</strong>
        <span>${escapeHtml(result.agentName || result.agentId)} · ${result.count} matches</span>
        <small>${escapeHtml((result.matches || []).map((match) => match.text).join(' · '))}</small>
      </button>
    `).join('') : '<p class="muted">No session logs matched.</p>';
    bindSessionOpenButtons($('#searchResults'));
    $$('[data-open-session]', $('#searchResults')).forEach((button) => {
      button.addEventListener('click', () => setModal('searchModal', false), { once: true });
    });
  } catch (err) {
    $('#searchResults').innerHTML = `<p class="muted">Search failed: ${escapeHtml(err.message)}</p>`;
  }
}

function bindEvents() {
  $$('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => navigateTab(button.dataset.tab));
  });
  $$('[data-jump]').forEach((button) => {
    button.addEventListener('click', () => navigateTab(button.dataset.jump));
  });
  window.addEventListener('hashchange', activateLocationTab);
  window.addEventListener('popstate', activateLocationTab);
  $('#themeSelect')?.addEventListener('change', (event) => setTheme(event.target.value));
  $('#refreshDashboardBtn')?.addEventListener('click', loadDashboard);
  $('#refreshAgentsBtn')?.addEventListener('click', async () => {
    await loadAgents();
    await loadDashboard();
  });
  $('#openAppSettingsBtn')?.addEventListener('click', () => setModal('appSettingsModal', true));
  $('#closeAppSettingsBtn')?.addEventListener('click', () => setModal('appSettingsModal', false));
  $('#openSearchBtn')?.addEventListener('click', () => setModal('searchModal', true));
  $('#closeSearchBtn')?.addEventListener('click', () => setModal('searchModal', false));
  $('#searchForm')?.addEventListener('submit', runSessionSearch);
  $$('.modal-layer').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) modal.classList.add('is-hidden');
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setModal('appSettingsModal', false);
      setModal('searchModal', false);
    }
  });
  $('#collapseSidebarBtn')?.addEventListener('click', () => {
    setSidebarCollapsed(!$('.workspace-shell')?.classList.contains('sidebar-collapsed'));
  });
  $('#agentForm').addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(state.selectedAgent, $('#agentInput').value, event.currentTarget, $('#agentInput'), 'agentMessages');
  });
  $('#attachFileBtn')?.addEventListener('click', () => $('#agentFileInput')?.click());
  $('#agentFileInput')?.addEventListener('change', handleChatFiles);
  $$('[data-chat-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
      $('#agentInput').value = button.dataset.chatSuggestion || '';
      $('#agentInput').focus();
    });
  });
  $('#agentInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#agentForm').requestSubmit();
    }
  });
  $('#agentSelect').addEventListener('change', (event) => {
    state.selectedAgent = event.target.value;
    renderChatHeader();
    renderMessages('agentMessages', state.selectedAgent);
    refreshChatSessionState(state.selectedAgent);
  });
  $('#newChatBtn')?.addEventListener('click', () => startNewChat(state.selectedAgent));
  $('#taskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await api('/api/tasks', {
      method: 'POST',
      body: {
        title: $('#taskTitle').value,
        details: $('#taskDetails').value,
        priority: $('#taskPriority').value,
        dueAt: $('#taskDue').value,
        column: 'backlog'
      }
    });
    form.reset();
    $('#taskTitle').value = '';
    $('#taskDetails').value = '';
    $('#taskDue').value = '';
    $('#taskPriority').value = 'normal';
    await loadTasks();
    await loadDashboard();
  });
  $('#taskMode').addEventListener('change', saveTaskSettings);
  $('#taskAuto').addEventListener('change', saveTaskSettings);
  $('#runQueueBtn').addEventListener('click', async () => {
    $('#queueState').textContent = 'running queue';
    const result = await api('/api/tasks/run', { method: 'POST' });
    $('#queueState').textContent = result.ran ? 'queue item complete' : 'nothing runnable';
    await loadTasks();
    await loadDashboard();
  });
  $('#sessionAgentSelect').addEventListener('change', () => {
    state.sessionPage = 1;
    state.memoryFilePage = 1;
    loadSessions();
  });
  $$('[data-memory-view]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.memoryView !== button.dataset.memoryView) {
        state.sessionPage = 1;
        state.memoryFilePage = 1;
      }
      setMemoryView(button.dataset.memoryView);
    });
  });
  $('#memoryEditorForm')?.addEventListener('submit', saveMemoryFile);
  $('#memoryEditorText')?.addEventListener('input', () => markFormDirty('#memoryEditorForm'));
  $('#settingsForm')?.addEventListener('input', () => markFormDirty('#settingsForm'));
  $('#settingsForm')?.addEventListener('change', () => markFormDirty('#settingsForm'));
  $('#settingsAgentSelect').addEventListener('change', (event) => {
    markFormClean('#settingsForm');
    state.selectedSettingsAgent = event.target.value;
    renderSettings();
  });
  $('#settingsForm').addEventListener('submit', saveSettings);
}

async function init() {
  bindEvents();
  setTheme(localStorage.getItem('ocui.theme') || 'claw-light');
  setSidebarCollapsed(localStorage.getItem('ocui.sidebarCollapsed') === '1');
  setMemoryView(state.memoryView);
  renderAttachmentTray();
  await loadHealth();
  await loadAgents();
  await loadSkills();
  await loadTasks();
  await loadDashboard();
  const requestedTab = requestedTabFromLocation();
  if (requestedTab && $(`#tab-${requestedTab}`)) {
    setActiveTab(requestedTab);
  } else if ($('#tab-swarm')?.classList.contains('is-active')) {
    await loadSwarm();
  }
  setInterval(loadHealth, 30000);
  setInterval(loadTasks, 15000);
  startRealtimeSync();
}

init().catch((err) => {
  console.error(err);
  $('#mobileHealth').textContent = 'error';
});
