'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocui-'));
  const openclawHome = path.join(root, '.openclaw');
  const workspace = path.join(openclawHome, 'workspace');
  const coderWorkspace = path.join(workspace, 'agents', 'coder');
  const sessionsDir = path.join(openclawHome, 'agents', 'coder', 'sessions');
  const mainSessionsDir = path.join(openclawHome, 'agents', 'main', 'sessions');
  const cronRunsDir = path.join(openclawHome, 'cron', 'runs');
  const dataDir = path.join(root, 'data');

  await fs.mkdir(coderWorkspace, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(mainSessionsDir, { recursive: true });
  await fs.mkdir(cronRunsDir, { recursive: true });
  await fs.mkdir(path.join(workspace, 'skills', 'clawddocs'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(workspace, 'MEMORY.md'), '# MEMORY.md\n\nMock memory file.\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'IDENTITY.md'), '# IDENTITY.md\n\n- **Name:** Atlas\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'SOUL.md'), '# SOUL.md\n\nAtlas personality.\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# AGENTS.md\n\nAtlas instructions.\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'TOOLS.md'), '# TOOLS.md\n\nAtlas tools.\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'skills', 'clawddocs', 'SKILL.md'), '# Claw docs\n\nMock skill summary.\n', 'utf8');
  await fs.writeFile(path.join(coderWorkspace, 'IDENTITY.md'), '# IDENTITY.md\n\n- **Name:** Forge\n- **Role:** coder\n', 'utf8');
  await fs.writeFile(path.join(coderWorkspace, 'SOUL.md'), '# SOUL.md\n\nCoder personality.\n', 'utf8');
  await fs.writeFile(path.join(coderWorkspace, 'AGENTS.md'), '# AGENTS.md\n\nCoder instructions.\n', 'utf8');
  await fs.writeFile(path.join(coderWorkspace, 'TOOLS.md'), '# TOOLS.md\n\nCoder tools.\n', 'utf8');

  const configPath = path.join(openclawHome, 'openclaw.json');
  await fs.writeFile(configPath, JSON.stringify({
    agents: {
      defaults: {
        workspace,
        model: { primary: 'openai-codex/gpt-5.5' },
        skills: ['self-improvement'],
        thinkingDefault: 'medium'
      },
      list: [
        { id: 'main', tools: { profile: 'coding' } },
        {
          id: 'coder',
          name: 'coder',
          workspace: coderWorkspace,
          agentDir: path.join(openclawHome, 'agents', 'coder'),
          model: 'openai-codex/gpt-5.5',
          thinkingDefault: 'medium',
          fastModeDefault: false,
          skills: ['clawddocs'],
          tools: { profile: 'coding', deny: ['sessions_spawn'] },
          identity: { name: 'Forge', theme: 'implementation' }
        }
      ]
    }
  }, null, 2), 'utf8');

  await fs.writeFile(path.join(sessionsDir, 'sessions.json'), JSON.stringify({
    'agent:coder:main': {
      sessionId: 'sess1',
      updatedAt: Date.now(),
      model: 'gpt-5.5',
      modelProvider: 'openai-codex',
      totalTokens: 42
    },
    'agent:coder:missing': {
      sessionId: 'missing-log',
      updatedAt: Date.now() - 1000,
      model: 'gpt-5.5',
      modelProvider: 'openai-codex'
    }
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(sessionsDir, 'sess1.jsonl'), '{"role":"user","text":"hello smoke-search-marker"}\n', 'utf8');
  const orphanSessionPath = path.join(sessionsDir, 'orphan-log.jsonl');
  await fs.writeFile(orphanSessionPath, [
    JSON.stringify({ type: 'session', timestamp: '2026-01-01T00:00:00.000Z', cwd: workspace }),
    JSON.stringify({ role: 'user', text: 'orphan smoke-search-marker' }),
    ''
  ].join('\n'), 'utf8');
  await fs.utimes(orphanSessionPath, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
  await fs.writeFile(path.join(mainSessionsDir, 'sessions.json'), JSON.stringify({
    'agent:main:cron:cron-job': {
      sessionId: 'cron-job',
      updatedAt: new Date('2026-01-02T00:00:00.000Z').getTime(),
      model: 'gpt-5.5',
      modelProvider: 'openai-codex'
    }
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(cronRunsDir, 'cron-job.jsonl'), [
    JSON.stringify({ ts: new Date('2026-01-02T00:00:00.000Z').getTime(), jobId: 'cron-job', action: 'finished', status: 'ok', summary: 'cron smoke-search-marker' }),
    ''
  ].join('\n'), 'utf8');

  process.env.OPENCLAW_WEB_UI_MOCK = '1';
  process.env.OPENCLAW_CONFIG = configPath;
  process.env.OPENCLAW_WEB_UI_DATA_DIR = dataDir;

  const { createApp, selectNextTask } = require('../server');
  const app = createApp();
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = app.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function request(route, options = {}) {
    const init = { ...options };
    if (init.body && typeof init.body !== 'string') {
      init.body = JSON.stringify(init.body);
      init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
    }
    const response = await fetch(`${base}${route}`, init);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    assert.ok(response.ok, `${route} failed: ${JSON.stringify(body)}`);
    return body;
  }

  const page = await request('/');
  assert.match(page, /Claw Space/);
  assert.match(page, /claw-space-logo\.svg/);
  assert.match(page, /Agent Settings/);
  assert.match(page, /settingsFastMode/);
  assert.match(page, /New Chat/);
  assert.doesNotMatch(page, /New Session/);
  assert.doesNotMatch(page, />Operations</);
  assert.doesNotMatch(page, />MCP</);
  assert.match(page, /Knowledge/);
  assert.match(page, /Task Board/);

  const health = await request('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.config.file, 'openclaw.json');
  assert.equal(health.configPath, undefined);

  const agents = await request('/api/agents');
  assert.deepEqual(agents.agents.map((agent) => agent.id), ['main', 'coder']);

  const chat = await request('/api/chat', { method: 'POST', body: { agentId: 'coder', message: 'ping' } });
  assert.match(chat.text, /\[coder\] ping/);

  const streamResponse = await fetch(`${base}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'coder', message: 'stream ping' })
  });
  assert.equal(streamResponse.ok, true);
  const streamText = await streamResponse.text();
  assert.match(streamText, /event: activity/);
  assert.match(streamText, /event: final/);
  assert.match(streamText, /sessionId/);
  assert.match(streamText, /\[coder\] stream ping/);

  const sessions = await request('/api/sessions?agent=coder');
  assert.equal(sessions.sessions[0].sessionId, 'sess1');
  assert.ok(sessions.sessions.some((session) => (
    session.sessionId === 'orphan-log'
      && session.registered === false
      && session.fileExists === true
  )));
  assert.ok(!sessions.sessions.some((session) => session.sessionId === 'missing-log'));

  const allSessions = await request('/api/sessions/all');
  assert.equal(allSessions.sessions[0].agentId, 'coder');

  const preview = await request('/api/sessions/coder/sess1/preview');
  assert.match(preview.lines.join('\n'), /hello/);
  assert.equal(preview.messages[0].label, 'You');

  const orphanPreview = await request('/api/sessions/coder/orphan-log/preview');
  assert.match(orphanPreview.lines.join('\n'), /orphan/);

  const mainSessions = await request('/api/sessions?agent=main');
  assert.equal(mainSessions.sessions[0].sessionId, 'cron-job');
  assert.equal(mainSessions.sessions[0].logSource, 'cron-run');
  const cronPreview = await request('/api/sessions/main/cron-job/preview');
  assert.match(cronPreview.lines.join('\n'), /cron smoke-search-marker/);

  const search = await request('/api/search-sessions?q=smoke-search-marker');
  assert.equal(search.results[0].sessionId, 'sess1');
  assert.ok(search.results.some((result) => result.sessionId === 'orphan-log'));

  const skills = await request('/api/skills');
  assert.ok(skills.skills.some((skill) => skill.id === 'clawddocs'));

  const syncBefore = await request('/api/sync-state');
  assert.ok(syncBefore.versions.agents);
  assert.ok(syncBefore.versions.skills);
  assert.ok(syncBefore.versions.sessions);
  assert.ok(syncBefore.versions.memory);
  assert.ok(syncBefore.versions.tasks);

  await fs.mkdir(path.join(workspace, 'skills', 'new-external-skill'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'skills', 'new-external-skill', 'SKILL.md'), '# External Skill\n\nAdded outside the web UI.\n', 'utf8');
  const syncAfterSkill = await request('/api/sync-state');
  assert.notEqual(syncAfterSkill.versions.skills, syncBefore.versions.skills);

  const memoryFiles = await request('/api/memory-files?agent=all');
  assert.ok(memoryFiles.files.some((file) => file.path === 'MEMORY.md'));
  const memoryFile = await request('/api/memory-file?path=MEMORY.md');
  assert.match(memoryFile.content, /Mock memory file/);
  const updatedMemory = await request('/api/memory-file', {
    method: 'PUT',
    body: { path: 'MEMORY.md', content: '# MEMORY.md\n\nUpdated mock memory file.\n' }
  });
  assert.equal(updatedMemory.ok, true);

  const download = await request('/api/sessions/coder/sess1/download');
  assert.match(download, /hello/);

  const exported = await request('/api/sessions/coder/export');
  assert.equal(exported.agentId, 'coder');
  assert.match(exported.sessions[0].log, /hello/);

  const created = await request('/api/tasks', {
    method: 'POST',
    body: { title: 'Test task', details: 'Do it', priority: 'urgent', column: 'backlog' }
  });
  assert.equal(created.task.status, 'pending');
  assert.equal(created.task.column, 'backlog');

  const moved = await request(`/api/tasks/${created.task.id}`, { method: 'PATCH', body: { column: 'todo' } });
  assert.equal(moved.task.column, 'todo');

  await request('/api/tasks/settings', { method: 'POST', body: { mode: 'priority', autoRun: false } });
  const queue = await request('/api/tasks/run', { method: 'POST' });
  assert.equal(queue.ran, true);
  assert.equal(queue.task.status, 'done');
  assert.equal(queue.task.column, 'done');

	  const dashboard = await request('/api/dashboard');
	  assert.equal(dashboard.agents.total, 2);

  const swarmHealth = await request('/api/swarm-health');
  assert.equal(swarmHealth.summary.totalWorkers, 1);

  const swarmRoster = await request('/api/swarm-roster');
  assert.equal(swarmRoster.roster.workers[0].id, 'coder');

  const swarmRuntime = await request('/api/swarm-runtime');
  assert.equal(swarmRuntime.entries[0].workerId, 'coder');

  const swarmMissions = await request('/api/swarm-missions?limit=5');
  assert.ok(Array.isArray(swarmMissions.missions));

  const swarmChat = await request('/api/swarm-chat?workerId=coder&limit=5');
  assert.equal(swarmChat.workerId, 'coder');
  assert.ok(Array.isArray(swarmChat.messages));

  const swarmCard = await request('/api/swarm-kanban', {
    method: 'POST',
    body: {
      title: 'Swarm card',
      spec: 'Check swarm board',
      assignedWorker: 'coder',
      status: 'ready',
      acceptanceCriteria: ['card exists']
    }
  });
  assert.equal(swarmCard.card.status, 'ready');
  assert.equal(swarmCard.card.assignedWorker, 'coder');

  const movedSwarmCard = await request('/api/swarm-kanban', {
    method: 'PATCH',
    body: { id: swarmCard.card.id, status: 'running' }
  });
  assert.equal(movedSwarmCard.card.status, 'running');

  const decompose = await request('/api/swarm-decompose', {
    method: 'POST',
    body: { goal: 'Prepare a tiny mock mission', workerIds: ['coder'] }
  });
  assert.equal(decompose.cards.length, 1);
  assert.equal(decompose.cards[0].assignedWorker, 'coder');

  const routedCard = await request(`/api/tasks/${decompose.cards[0].id}/run`, { method: 'POST' });
  assert.equal(routedCard.task.status, 'done');
  assert.match(routedCard.task.result, /\[coder\]/);

  const dryDispatch = await request('/api/swarm-dispatch', {
    method: 'POST',
    body: { message: 'route this', mode: 'manual', workerIds: ['coder'], dryRun: true }
  });
  assert.deepEqual(dryDispatch.targets, ['coder']);

  const dispatch = await request('/api/swarm-dispatch', {
    method: 'POST',
    body: { message: 'mock swarm ping', mode: 'manual', workerIds: ['coder'] }
  });
  assert.match(dispatch.results[0].text, /\[coder\]/);

  const direct = await request('/api/swarm-direct-chat', {
    method: 'POST',
    body: { workerId: 'coder', message: 'direct ping' }
  });
  assert.match(direct.reply.text, /\[coder\]/);

  const reports = await request('/api/swarm-reports');
  assert.ok(Array.isArray(reports.missions));

  const settings = await request('/api/config/coder', {
    method: 'POST',
    body: {
      name: 'coder',
      model: 'openai-codex/gpt-5.5',
      thinkingDefault: 'medium',
      fastModeDefault: true,
      skills: 'clawddocs\nself-improvement',
      tools: '{"profile":"coding","deny":["sessions_spawn"]}',
      identity: { name: 'Forge' },
      personality: '# SOUL.md\n\nUpdated coder personality.\n',
      instructions: '# AGENTS.md\n\nUpdated coder instructions.\n'
    }
  });
  assert.equal(settings.agent.identity.name, 'Forge');
  assert.equal(settings.agent.fastModeDefault, true);
  assert.match(await fs.readFile(path.join(coderWorkspace, 'SOUL.md'), 'utf8'), /Updated coder personality/);

  const next = selectNextTask([
    { id: 'a', status: 'pending', priority: 'low', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', status: 'pending', priority: 'urgent', createdAt: '2026-01-02T00:00:00Z' }
  ], 'priority');
  assert.equal(next.id, 'b');

  await new Promise((resolve) => app.close(resolve));
  console.log('smoke-ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
