const { execFileSync } = require('child_process');

const jobs = [
  { id: 'job1', command: 'echo Hello from job1', max_retries: 3 },
  { id: 'job2', command: 'bash -c "exit 1"', max_retries: 2 },
  { id: 'job3', command: 'sleep 2 && echo done', max_retries: 2 },
  { id: 'job4', command: 'echo Hello from Windows', max_retries: 2 },
  { id: 'job5', command: 'timeout /t 2 && echo Done', max_retries: 2 },
];

jobs.forEach(job => {
  const json = JSON.stringify(job);
  try {
    execFileSync('node', ['queuectl.js', 'enqueue', json], { stdio: 'inherit' });
  } catch (err) {
    console.error(`❌ Failed to enqueue ${job.id}:`, err.message);
  }
});
