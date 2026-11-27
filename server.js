const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const activeJobs = new Map();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  if (!WORKER_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  return auth === 'Bearer ' + WORKER_TOKEN;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 1e6) reject(new Error('Payload terlalu besar'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error('JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

function spawnCloneTask(jobId, targetUrl) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const url = process.argv[1];
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        console.log(JSON.stringify({ tick, url, ts: new Date().toISOString() }));
        if (tick >= 6) {
          clearInterval(timer);
          console.log('TASK_DONE');
          process.exit(0);
        }
      }, 1500);
      `,
      targetUrl
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    }
  );

  const entry = {
    jobId,
    targetUrl,
    pid: child.pid,
    child,
    status: 'running',
    startedAt: new Date().toISOString(),
    terminatedAt: null,
    logs: []
  };

  activeJobs.set(jobId, entry);

  child.stdout.on('data', (buf) => {
    entry.logs.push(buf.toString('utf8').trim());
    if (entry.logs.length > 50) entry.logs.shift();
  });

  child.stderr.on('data', (buf) => {
    entry.logs.push('ERR: ' + buf.toString('utf8').trim());
    if (entry.logs.length > 50) entry.logs.shift();
  });

  child.on('exit', (code, signal) => {
    const current = activeJobs.get(jobId);
    if (!current) return;
    if (current.status !== 'terminated') {
      current.status = code === 0 ? 'completed' : 'exited';
      current.exitCode = code;
      current.signal = signal || null;
      current.finishedAt = new Date().toISOString();
    }
  });

  return entry;
}

function hardKillJob(jobId) {
  const entry = activeJobs.get(jobId);
  if (!entry) {
    return { ok: false, message: 'Job tidak ditemukan di worker', jobId };
  }

  entry.status = 'terminated';
  entry.terminatedAt = new Date().toISOString();

  if (entry.child && !entry.child.killed) {
    try {
      if (process.platform !== 'win32' && entry.pid) {
        process.kill(-entry.pid, 'SIGKILL');
      } else {
        entry.child.kill('SIGKILL');
      }
    } catch (_) {
      try {
        entry.child.kill('SIGKILL');
      } catch (__) {}
    }
  }

  return {
    ok: true,
    jobId,
    status: entry.status,
    terminatedAt: entry.terminatedAt
  };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true, status: 'alive' });
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  if (req.method === 'POST' && pathname === '/start') {
    try {
      const body = await readJsonBody(req);
      const jobId = String(body.jobId || '').trim();
      const targetUrl = String(body.targetUrl || '').trim();
      if (!jobId || !/^https?:\/\//i.test(targetUrl)) {
        return sendJson(res, 400, { ok: false, error: 'jobId dan targetUrl valid wajib diisi' });
      }
      const existing = activeJobs.get(jobId);
      if (existing && existing.status === 'running') {
        hardKillJob(jobId);
      }
      const started = spawnCloneTask(jobId, targetUrl);
      return sendJson(res, 200, { ok: true, jobId: started.jobId, pid: started.pid, status: started.status });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/terminate') {
    try {
      const body = await readJsonBody(req);
      const jobId = String(body.jobId || '').trim();
      if (!jobId) {
        return sendJson(res, 400, { ok: false, error: 'jobId wajib diisi' });
      }
      return sendJson(res, 200, hardKillJob(jobId));
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/status/')) {
    const jobId = pathname.replace('/status/', '').trim();
    const entry = activeJobs.get(jobId);
    if (!entry) {
      return sendJson(res, 404, { ok: false, error: 'Job tidak ditemukan' });
    }
    const { child, ...safeInfo } = entry;
    return sendJson(res, 200, { ok: true, job: safeInfo });
  }

  return sendJson(res, 404, { ok: false, error: 'Endpoint tidak ditemukan' });
});

server.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
