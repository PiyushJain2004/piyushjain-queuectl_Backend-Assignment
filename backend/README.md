🚀 QueueCTL – Backend Developer Assignment

🧠 A CLI-based background job queue system built using Node.js and SQLite, for Flam’s Backend Developer Internship assignment.

QueueCTL allows you to:
✅ Enqueue background jobs
✅ Run multiple worker processes
✅ Retry failed jobs with exponential backoff
✅ Move permanently failed jobs to a Dead Letter Queue (DLQ)
✅ Persist data across restarts

⚙️ Tech Stack`
Component	Technology
🧑‍💻 Language	Node.js (v18+)
🗃️ Database	SQLite (via better-sqlite3)
🧭 CLI Framework	Commander.js
⚡ Process Execution	child_process.exec
🪄 Optional Utility	uuid for unique IDs
🎯 Objective

Build a production-grade queue system that supports:

🧾 Enqueuing and managing background jobs

⚙️ Running multiple workers concurrently

🔁 Automatic retries for failed jobs

⏱️ Exponential backoff between retries

💾 Persistent job storage across restarts

🧺 Dead Letter Queue (DLQ) for failed jobs

🧩 CLI-based configuration and management

⚙️ System Requirements
🔹 1. Job Execution

Each worker executes a shell command (e.g., echo hello, timeout /t 2 && echo Done).

Exit codes determine success or failure.

Failed commands trigger automatic retries.

🔹 2. Retry & Backoff

Implements exponential backoff:

delay = base ^ attempts   (in seconds)


Moves a job to the DLQ after exceeding max_retries.

🔹 3. Persistence

Uses SQLite (queue.db) to persist job data.

Jobs survive restarts.

🔹 4. Worker Management

Multiple workers process jobs in parallel.

Prevents duplicate job execution using atomic DB locking.

Graceful shutdown ensures current job completion before exit.

🔹 5. Configuration

CLI supports modifying:

max_retries

backoff_base

🧩 Job Schema
{
  "id": "unique-job-id",
  "command": "echo Hello World",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2025-11-10T10:30:00Z",
  "updated_at": "2025-11-10T10:30:00Z"
}

💻 CLI Commands
Category	Command	Description
🏁 Initialize	node queuectl.js init	Create DB and default config
📦 Enqueue	node queuectl.js enqueue '{"id":"job1","command":"echo hi"}'	Add a new job
⚙️ Workers	node queuectl.js worker start --count 2	Start N workers
	node queuectl.js worker stop	Stop workers gracefully
📊 Status	node queuectl.js status	Show job counts and active worker PIDs
🧾 List Jobs	node queuectl.js list --state pending	List jobs by state
🧺 DLQ	node queuectl.js dlq list	View DLQ jobs
	node queuectl.js dlq retry job1	Retry DLQ job
⚙️ Config	node queuectl.js config set max-retries 5	Update retry config
🧰 Recover	node queuectl.js recover	Reset stuck processing jobs
🧠 Architecture Overview
graph TD
    A[CLI Interface] -->|Enqueue Job| B[(SQLite DB)]
    B --> C{Worker Manager}
    C -->|Claim Job| D[Worker Process]
    D -->|Exec Command| E[Job Result]
    E -->|Success| F[Completed ✅]
    E -->|Fail + Retry| G[Backoff Delay 🔁]
    G -->|Exceeded Retries| H[Dead Letter Queue 🧺]
    H -->|Manual Retry| C


Component Highlights:

🧭 CLI: Built using Commander.js for intuitive command syntax

💾 SQLite: Persistent job and config storage

⚙️ Worker Processes: Spawned via child_process.fork() for concurrency

🔁 Retry Logic: Uses exponential backoff (base ^ attempts)

🧺 DLQ: Stores permanently failed jobs with error details

🧹 Graceful Shutdown: Handles SIGINT and SIGTERM

🧪 Example Run
🪄 Step 1: Initialize and Enqueue Jobs
node queuectl.js init
node enqueue_jobs.js

🔍 Step 2: Check Pending Jobs
node queuectl.js list --state pending

⚙️ Step 3: Start Workers
node queuectl.js worker start --count 2


Sample Output:

Started 2 workers (PIDs: 9704, 19032)
[9704] Executing job job1: echo Hello from job1
[9704] Job job1 completed
[19032] Executing job job2: bash -c "exit 1"
[9704] Executing job job3: sleep 2 && echo done
[9704] Job job3 failed (attempt 1), will retry ...
[9704] Job job3 moved to DLQ after 2 attempts

🧺 Step 4: Check DLQ
node queuectl.js dlq list

♻️ Step 5: Retry a DLQ Job
node queuectl.js dlq retry job5

🛑 Step 6: Stop Workers
node queuectl.js worker stop

🧾 Testing Instructions

Run the full flow:

node queuectl.js init
node enqueue_jobs.js
node queuectl.js worker start --count 2
node queuectl.js dlq list
node queuectl.js status


✅ Expected Results

Successful jobs: echo → completed

Invalid commands: retried → DLQ

Persistent job data in queue.db

## 🎥 Demo Video
[▶️ Watch the working demo here](https://drive.google.com/file/d/1pIaAZOQPEUbToQdrECoN37PO0wPZcl15/view?usp=sharing)
