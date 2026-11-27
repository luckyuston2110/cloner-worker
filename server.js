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
      if (raw.length > 2e6) reject(new Error('Payload terlalu besar'));
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

function buildInspectorScript() {
  return `
    const targetUrl = process.argv[1];
    const mode = process.argv[2] || 'inspect';

    (async () => {
      if (mode === 'sim') {
        let tick = 0;
        const timer = setInterval(() => {
          tick += 1;
          console.log('LOG:' + JSON.stringify({ tick, targetUrl, ts: new Date().toISOString() }));
          if (tick >= 5) {
            clearInterval(timer);
            console.log('REPORT:' + JSON.stringify({
              mode: 'sim',
              targetUrl,
              title: 'Simulated Target',
              navItems: ['Dashboard', 'Reports', 'Settings'],
              apiEndpoints: []
            }));
            process.exit(0);
          }
        }, 1500);
        return;
      }

      let chromium;
      try {
        ({ chromium } = require('playwright'));
      } catch (err) {
        console.error('Playwright belum terpasang:', err.message);
        process.exit(2);
      }

      let browser;
      try {
        console.log('LOG:Meluncurkan headless Chromium untuk inspeksi...');
        browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process'
          ]
        });

        const context = await browser.newContext({
          viewport: { width: 1366, height: 800 }
        });
        const page = await context.newPage();

        const apiEndpoints = new Map();
        page.on('response', async (resp) => {
          try {
            const req = resp.request();
            const type = req.resourceType();
            if (type === 'xhr' || type === 'fetch') {
              const u = new URL(resp.url());
              const key = req.method() + ' ' + u.origin + u.pathname;
              if (!apiEndpoints.has(key)) {
                apiEndpoints.set(key, {
                  method: req.method(),
                  url: u.origin + u.pathname,
                  status: resp.status(),
                  contentType: resp.headers()['content-type'] || ''
                });
              }
            }
          } catch (_) {}
        });

        console.log('LOG:Membuka URL target ' + targetUrl);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2500);

        const extracted = await page.evaluate(() => {
          const cleanText = (el) => (el && el.innerText ? el.innerText.trim().replace(/\\s+/g, ' ') : '');
          const bodyStyle = window.getComputedStyle(document.body);

          const navLinks = Array.from(document.querySelectorAll('nav a, aside a, header a, [role="navigation"] a'))
            .map((a) => ({ text: cleanText(a), href: a.getAttribute('href') || '' }))
            .filter((x) => x.text)
            .slice(0, 40);

          const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
            .map((h) => ({ tag: h.tagName.toLowerCase(), text: cleanText(h) }))
            .filter((x) => x.text)
            .slice(0, 30);

          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
            .map((b) => cleanText(b))
            .filter(Boolean)
            .slice(0, 30);

          const forms = Array.from(document.querySelectorAll('form')).map((f) => {
            const inputs = Array.from(f.querySelectorAll('input, select, textarea')).map((inp) => ({
              tag: inp.tagName.toLowerCase(),
              type: inp.getAttribute('type') || 'text',
              name: inp.getAttribute('name') || inp.getAttribute('id') || '',
              placeholder: inp.getAttribute('placeholder') || ''
            }));
            return {
              action: f.getAttribute('action') || '',
              method: (f.getAttribute('method') || 'GET').toUpperCase(),
              inputs: inputs.slice(0, 20)
            };
          }).slice(0, 10);

          const htmlSnippet = (document.documentElement.outerHTML || '').slice(0, 12000);

          return {
            title: document.title || '',
            finalUrl: window.location.href,
            designTokens: {
              fontFamily: bodyStyle.fontFamily,
              fontSize: bodyStyle.fontSize,
              backgroundColor: bodyStyle.backgroundColor,
              textColor: bodyStyle.color
            },
            navLinks,
            headings,
            buttons,
            forms,
            htmlSnippet
          };
        });

        const report = {
          mode: 'inspect',
          targetUrl,
          inspectedAt: new Date().toISOString(),
          ...extracted,
          apiEndpoints: Array.from(apiEndpoints.values()).slice(0, 40)
        };

        console.log('REPORT:' + JSON.stringify(report));
        await browser.close();
        process.exit(0);
      } catch (err) {
        if (browser) {
          try { await browser.close(); } catch (_) {}
        }
        console.error('Inspection error:', err.message);
        process.exit(1);
      }
    })();
  `;
}

function spawnCloneTask(jobId, targetUrl, mode = 'inspect') {
  const child = spawn(
    process.execPath,
    ['-e', buildInspectorScript(), targetUrl, mode],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    }
  );

  const entry = {
    jobId,
    targetUrl,
    mode,
    pid: child.pid,
    child,
    status: 'running',
    startedAt: new Date().toISOString(),
    terminatedAt: null,
    logs: [],
    report: null
  };

  activeJobs.set(jobId, entry);

  const handleOutputChunk = (buf, isErr) => {
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('REPORT:')) {
        try {
          entry.report = JSON.parse(line.slice('REPORT:'.length));
          entry.logs.push('[' + new Date().toLocaleTimeString('id-ID') + '] Laporan inspeksi berhasil disusun.');
        } catch (e) {
          entry.logs.push('ERR parsing report: ' + e.message);
        }
      } else if (line.startsWith('LOG:')) {
        entry.logs.push('[' + new Date().toLocaleTimeString('id-ID') + '] ' + line.slice('LOG:'.length));
      } else {
        entry.logs.push((isErr ? 'ERR: ' : '') + line);
      }
      if (entry.logs.length > 80) entry.logs.shift();
    }
  };

  child.stdout.on('data', (buf) => handleOutputChunk(buf, false));
  child.stderr.on('data', (buf) => handleOutputChunk(buf, true));

  child.on('exit', (code, signal) => {
    const current = activeJobs.get(jobId);
    if (!current) return;
    if (current.status !== 'terminated') {
      current.status = code === 0 ? 'completed' : 'failed';
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
      const mode = body.mode === 'sim' ? 'sim' : 'inspect';

      if (!jobId || !/^https?:\/\//i.test(targetUrl)) {
        return sendJson(res, 400, { ok: false, error: 'jobId dan targetUrl valid wajib diisi' });
      }

      const existing = activeJobs.get(jobId);
      if (existing && existing.status === 'running') {
        hardKillJob(jobId);
      }

      const started = spawnCloneTask(jobId, targetUrl, mode);
      return sendJson(res, 200, {
        ok: true,
        jobId: started.jobId,
        pid: started.pid,
        mode: started.mode,
        status: started.status
      });
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
