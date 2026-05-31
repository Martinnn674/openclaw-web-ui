'use strict';

const assert = require('assert');
const { createApp } = require('../server');

async function main() {
  const app = createApp();
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
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
    assert.ok(response.ok, `${route} failed: ${JSON.stringify(body).slice(0, 500)}`);
    return body;
  }

  const page = await request('/');
  assert.match(page, /Task Board/);
  assert.match(page, /Claw Space/);
  assert.match(page, /claw-space-logo\.svg/);
  assert.match(page, /Agent Settings/);
  assert.match(page, /settingsFastMode/);
  assert.match(page, /securityStatusCard/);
  assert.doesNotMatch(page, /New Session/);

  const health = await request('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.config.file, 'openclaw.json');
  assert.equal(health.configPath, undefined);
  assert.equal(health.network.loopback, true);
  assert.equal(health.security.localOnly, true);

  const agents = await request('/api/agents');
  const agentIds = agents.agents.map((agent) => agent.id);
  assert.ok(agentIds.includes('main'), 'missing agent main');
  const workerIdsFromAgents = agentIds.filter((id) => id !== 'main');
  const liveAgentId = workerIdsFromAgents[0] || 'main';

  const dashboard = await request('/api/dashboard');
  assert.ok(dashboard.agents.total >= 1);

  const swarmHealth = await request('/api/swarm-health');
  assert.ok(swarmHealth.summary.totalWorkers >= 0);

  const swarmRoster = await request('/api/swarm-roster');
  const workerIds = swarmRoster.roster.workers.map((worker) => worker.id);
  for (const id of workerIdsFromAgents) {
    assert.ok(workerIds.includes(id), `missing swarm worker ${id}`);
  }

  const swarmRuntime = await request('/api/swarm-runtime');
  assert.ok(Array.isArray(swarmRuntime.entries));

  const swarmKanban = await request('/api/swarm-kanban');
  assert.ok(Array.isArray(swarmKanban.cards));

  const swarmReports = await request('/api/swarm-reports');
  assert.ok(Array.isArray(swarmReports.missions));

  const skills = await request('/api/skills');
  assert.ok(Array.isArray(skills.skills));

  const allSessions = await request('/api/sessions/all');
  assert.ok(Array.isArray(allSessions.sessions));

  const memoryFiles = await request('/api/memory-files?agent=all');
  assert.ok(Array.isArray(memoryFiles.files));

  if (workerIds.length) {
    const dryDispatch = await request('/api/swarm-dispatch', {
      method: 'POST',
      body: {
        message: 'Live dry-run only. Do not execute.',
        mode: 'manual',
        workerIds: [workerIds[0]],
        dryRun: true
      }
    });
    assert.deepEqual(dryDispatch.targets, [workerIds[0]]);
  }

  const kanbanCard = await request('/api/swarm-kanban', {
    method: 'POST',
    body: {
      title: 'OpenClaw Web UI live swarm card route check',
      spec: 'Temporary card created by live test.',
      assignedWorker: liveAgentId,
      status: 'ready'
    }
  });
  assert.equal(kanbanCard.card.status, 'ready');
  const movedKanbanCard = await request('/api/swarm-kanban', {
    method: 'PATCH',
    body: { id: kanbanCard.card.id, status: 'blocked' }
  });
  assert.equal(movedKanbanCard.card.status, 'blocked');
  await request(`/api/tasks/${kanbanCard.card.id}`, { method: 'DELETE' });

  if (workerIds.length) {
    const decomposed = await request('/api/swarm-decompose', {
      method: 'POST',
      body: {
        goal: 'OpenClaw Web UI live decompose route check',
        workerIds: [workerIds[0]]
      }
    });
    assert.equal(decomposed.cards.length, 1);
    await request(`/api/tasks/${decomposed.cards[0].id}`, { method: 'DELETE' });
  }

  const sessions = await request(`/api/sessions?agent=${liveAgentId}`);
  assert.ok(Array.isArray(sessions.sessions));
  const downloadable = sessions.sessions.find((session) => session.fileExists);
  if (downloadable) {
    const preview = await request(`/api/sessions/${liveAgentId}/${encodeURIComponent(downloadable.sessionId)}/preview`);
    assert.ok(Array.isArray(preview.lines));
    const exported = await request(`/api/sessions/${liveAgentId}/export`);
    assert.equal(exported.agentId, liveAgentId);
    assert.ok(Array.isArray(exported.sessions));
  }

  const chat = await request('/api/chat', {
    method: 'POST',
    body: {
      agentId: liveAgentId,
      message: 'OpenClaw Web UI live route check. Reply exactly: web-ui-live-ready'
    }
  });
  assert.match(chat.text, /web-ui-live-ready/);

  const search = await request('/api/search-sessions?q=web-ui-live-ready');
  assert.ok(Array.isArray(search.results));

  const created = await request('/api/tasks', {
    method: 'POST',
    body: {
      title: 'OpenClaw Web UI live task route check',
      details: 'Reply with a short status containing the phrase web-ui-task-ready. Do not do anything external.',
      priority: 'low'
    }
  });
  const task = await request(`/api/tasks/${created.task.id}/run`, { method: 'POST' });
  assert.equal(task.task.status, 'done');
  assert.equal(task.task.column, 'done');
  assert.match(task.task.result, /web-ui-task-ready/i);
  await request(`/api/tasks/${created.task.id}`, { method: 'DELETE' });

  await new Promise((resolve) => app.close(resolve));
  console.log('live-ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
