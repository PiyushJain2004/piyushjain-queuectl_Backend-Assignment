const { Command } = require('commander');
const Database = require('better-sqlite3');
const { exec } = require('child_process');
const { fork } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.QUEUE_DB || path.join(process.cwd(), 'queue.db');
const PID_FILE = path.join(process.cwd(), 'queuectl_workers.pid');

function openDb() {
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  return db;
}

function initDb() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      available_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?,?)');
  insert.run('backoff-base', '2');
  insert.run('max-retries', '3');
  db.close();
}

function nowIso() {
  return new Date().toISOString();
}

function getConfig(db, key, fallback) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

/* --- CLI Setup --- */
const program = new Command();
program.name('queuectl').description('Minimal queuectl (Node.js)');

/* init */
program
  .command('init')
  .description('Init DB (queue.db)')
  .action(() => {
    initDb();
    console.log('Initialized DB at', DB_FILE);
  });

/* enqueue */
program
  .command('enqueue <json>')
  .description("Enqueue job JSON (string). Example: '{\"id\":\"job1\",\"command\":\"sleep 1\"}'")
  .action((json) => {
    const db = openDb();
    let job;
    try {
      job = JSON.parse(json);
    } catch (e) {
      console.error('Invalid JSON:', e.message);
      process.exit(1);
    }
    const id = job.id || uuidv4();
    const command = job.command;
    if (!command) {
      console.error('Job must include \"command\"');
      process.exit(1);
    }
    const max_retries = job.max_retries || parseInt(getConfig(db, 'max-retries', '3'));
    const now = nowIso();
    const insert = db.prepare(`INSERT INTO jobs
      (id, command, state, attempts, max_retries, created_at, updated_at, available_at)
      VALUES (@id, @command, 'pending', 0, @max_retries, @now, @now, @now)`);
    try {
      insert.run({ id, command, max_retries, now });
      console.log('Enqueued job', id);
    } catch (e) {
      console.error('Insert failed:', e.message);
    } finally {
      db.close();
    }
  });

/* list */
program
  .command('list')
  .option('--state <state>', 'Filter by state')
  .description('List jobs')
  .action((opts) => {
    const db = openDb();
    let rows;
    if (opts.state) {
      rows = db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at').all(opts.state);
    } else {
      rows = db.prepare('SELECT * FROM jobs ORDER BY created_at').all();
    }
    if (!rows.length) {
      console.log('No jobs found.');
    } else {
      console.table(rows.map(r => ({ id: r.id, state: r.state, attempts: r.attempts, cmd: r.command, available_at: r.available_at })));
    }
    db.close();
  });

/* status */
program
  .command('status')
  .description('Show summary')
  .action(() => {
    const db = openDb();
    const counts = db.prepare(`SELECT state, COUNT(*) as cnt FROM jobs GROUP BY state`).all();
    const summary = {};
    counts.forEach(r => summary[r.state] = r.cnt);
    console.log('Jobs summary:', summary);
    if (fs.existsSync(PID_FILE)) {
      const pids = fs.readFileSync(PID_FILE, 'utf8').trim().split('\n').filter(Boolean);
      console.log('Worker PIDs:', pids);
    } else {
      console.log('No worker PID file.');
    }
    db.close();
  });

/* DLQ */
const dlq = program.command('dlq').description('Dead Letter Queue operations');

dlq
  .command('list')
  .description('List dead jobs')
  .action(() => {
    const db = openDb();
    const rows = db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY updated_at').all('dead');
    if (!rows.length) {
      console.log('No dead jobs.');
    } else {
      console.table(rows.map(r => ({ id: r.id, attempts: r.attempts, cmd: r.command, last_error: r.last_error })));
    }
    db.close();
  });

dlq
  .command('retry <id>')
  .description('Retry a job from DLQ by id (reset attempts and set pending)')
  .action((id) => {
    const db = openDb();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) { console.error('Not found'); db.close(); process.exit(1); }
    db.prepare('UPDATE jobs SET attempts=0, state="pending", updated_at=?, available_at=? WHERE id = ?')
      .run(nowIso(), nowIso(), id);
    console.log('Job retried:', id);
    db.close();
  });

/* config set */
program
  .command('config set <key> <value>')
  .description('Set configuration key (backoff-base, max-retries)')
  .action((key, value) => {
    const db = openDb();
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?,?)').run(key, value);
    console.log('Config set', key, value);
    db.close();
  });

/* --- Worker commands (single parent) --- */

function startWorkers(count) {
  // spawn child processes that run this same file with --run-worker
  const pids = [];
  for (let i = 0; i < count; i++) {
    const child = fork(__filename, ['--run-worker'], { stdio: 'inherit' });
    pids.push(child.pid);
  }
  try {
    fs.writeFileSync(PID_FILE, pids.join('\n') + '\n');
  } catch (e) {
    console.error('Could not write PID file:', e.message);
  }
  console.log(`Started ${count} workers (PIDs: ${pids.join(', ')})`);
}

const workerCmd = program.command('worker').description('Worker operations');

workerCmd
  .command('start')
  .option('--count <n>', 'Number of worker processes', parseInt)
  .description('Start worker(s)')
  .action((opts) => {
    const count = Number.isFinite(opts.count) ? opts.count : 1;
    startWorkers(count);
  });


workerCmd
  .command('stop')
  .description('Stop workers gracefully by reading pid file')
  .action(() => {
    if (!fs.existsSync(PID_FILE)) {
      console.log('No PID file.');
      return;
    }
    const pids = fs.readFileSync(PID_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    for (const pid of pids) {
      try {
        // send SIGINT
        process.kill(pid, 'SIGINT');
        console.log('Sent SIGINT to', pid);
      } catch (e) {
        console.log('Could not signal pid', pid, e.message);
      }
    }
    try { fs.unlinkSync(PID_FILE); } catch(e) {}
  });

/* --- Worker logic --- */

async function runCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { shell: true }, (error, stdout, stderr) => {
      const code = error ? (error.code || 1) : 0;
      resolve({ code, stdout, stderr, error });
    });
  });
}

async function workerLoop() {
  const db = openDb();
  console.log('Worker started PID', process.pid);
  let stopped = false;
  process.on('SIGINT', () => {
    console.log('Worker PID', process.pid, 'received SIGINT, stopping after current job');
    stopped = true;
  });
  process.on('SIGTERM', () => {
    console.log('Worker PID', process.pid, 'received SIGTERM, stopping after current job');
    stopped = true;
  });

  const claimTx = db.transaction(() => {
    // pick a job that is pending OR failed and available
    const candidate = db.prepare(`
      SELECT id FROM jobs
      WHERE (state = 'pending' OR (state = 'failed' AND datetime(available_at) <= datetime('now')))
      ORDER BY created_at LIMIT 1
    `).get();
    if (!candidate) return null;
    const res = db.prepare(`
      UPDATE jobs SET state = 'processing', updated_at = ?
      WHERE id = ? AND state IN ('pending','failed')
    `).run(nowIso(), candidate.id);
    if (res.changes === 1) return candidate.id;
    return null;
  });

  while (!stopped) {
    let jobId = null;
    try {
      jobId = claimTx();
    } catch (e) {
      console.error('Claim transaction failed:', e.message);
      // small sleep on DB errors
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    if (!jobId) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) continue;

    console.log(`[${process.pid}] Executing job ${job.id}: ${job.command}`);
    const result = await runCommand(job.command);
    const backoffBase = parseFloat(getConfig(db, 'backoff-base', '2')) || 2;

    if (result.code === 0) {
      db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?')
        .run('completed', nowIso(), job.id);
      console.log(`[${process.pid}] Job ${job.id} completed`);
    } else {
      const attempts = job.attempts + 1;
      const lastErr = (result.error && result.error.message) || (result.stderr && result.stderr.toString()) || 'error';
      if (attempts >= job.max_retries) {
        db.prepare('UPDATE jobs SET state=?, attempts=?, updated_at=?, last_error=? WHERE id=?')
          .run('dead', attempts, nowIso(), lastErr, job.id);
        console.log(`[${process.pid}] Job ${job.id} moved to DLQ after ${attempts} attempts`);
      } else {
        const delay = Math.pow(backoffBase, attempts);
        const availableAt = new Date(Date.now() + delay * 1000).toISOString();
        db.prepare('UPDATE jobs SET state=?, attempts=?, available_at=?, updated_at=?, last_error=? WHERE id=?')
          .run('failed', attempts, availableAt, nowIso(), lastErr, job.id);
        console.log(`[${process.pid}] Job ${job.id} failed (attempt ${attempts}), will retry at ${availableAt}`);
      }
    }
  }

  console.log('Worker PID', process.pid, 'exiting');
  db.close();
}

/* --- Recovery utility --- */
program
  .command('recover')
  .description('Reset stale processing jobs back to failed/pending (manual recovery)')
  .option('--stale-seconds <n>', 'Consider processing jobs stale after n seconds', parseInt, 3600)
  .action((opts) => {
    const db = openDb();
    const staleThreshold = new Date(Date.now() - (opts.staleSeconds * 1000)).toISOString();
    const rows = db.prepare('SELECT * FROM jobs WHERE state = \'processing\' AND updated_at <= ?').all(staleThreshold);
    if (!rows.length) {
      console.log('No stale processing jobs found.');
      db.close();
      return;
    }
    const update = db.prepare('UPDATE jobs SET state=?, attempts=attempts+1, available_at=?, updated_at=? WHERE id = ?');
    for (const r of rows) {
      const backoffBase = parseFloat(getConfig(db, 'backoff-base', '2')) || 2;
      const attempts = r.attempts + 1;
      if (attempts >= r.max_retries) {
        db.prepare('UPDATE jobs SET state=?, attempts=?, updated_at=?, last_error=? WHERE id=?')
          .run('dead', attempts, nowIso(), 'stale-processing-recovered', r.id);
        console.log('Moved stale job to dead:', r.id);
      } else {
        const delay = Math.pow(backoffBase, attempts);
        const availableAt = new Date(Date.now() + delay * 1000).toISOString();
        update.run('failed', availableAt, nowIso(), r.id);
        console.log('Reset stale job to failed (will retry):', r.id);
      }
    }
    db.close();
  });

/* --- Entry point: worker mode or CLI --- */
if (process.argv.includes('--run-worker')) {
  workerLoop().catch(err => { console.error('Worker error', err); process.exit(1); });
} else {
  program.parse(process.argv);
}
