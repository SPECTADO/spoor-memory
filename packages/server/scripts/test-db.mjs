// `pnpm test:db:up` / `pnpm test:db:down`: a throwaway pgvector Postgres for the integration tests.
// Fixed container name and host port (55432) so the default test DATABASE_URL just works; data lives in
// tmpfs and durability is off (fast, disposable). Same image as docker-compose.yml and CI.
import { execFileSync, spawnSync } from 'node:child_process'

const NAME = 'spoor-test-db'
const PORT = '55432'
const IMAGE =
  'pgvector/pgvector:0.8.7-pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d'
const URL = `postgres://spoor:spoor@localhost:${PORT}/spoor_test`

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts })

function running() {
  const r = docker(['inspect', '-f', '{{.State.Running}}', NAME])
  return r.status === 0 && r.stdout.trim() === 'true'
}

async function up() {
  if (!running()) {
    docker(['rm', '-f', NAME]) // a stopped leftover would block the name
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        NAME,
        '-e',
        'POSTGRES_USER=spoor',
        '-e',
        'POSTGRES_PASSWORD=spoor',
        '-e',
        'POSTGRES_DB=spoor_test',
        '-p',
        `127.0.0.1:${PORT}:5432`,
        '--tmpfs',
        '/var/lib/postgresql/data',
        IMAGE,
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
        '-c',
        'full_page_writes=off',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
  }
  // the image restarts postgres once after initdb, so require two consecutive successes over TCP
  let ok = 0
  for (let i = 0; i < 120 && ok < 2; i++) {
    const r = docker(['exec', NAME, 'pg_isready', '-h', '127.0.0.1', '-U', 'spoor', '-d', 'spoor_test'])
    ok = r.status === 0 ? ok + 1 : 0
    await new Promise((res) => setTimeout(res, 500))
  }
  if (ok < 2) {
    console.error(`${NAME} did not become ready`)
    process.exit(1)
  }
  console.log(`${NAME} ready: DATABASE_URL=${URL}`)
}

function down() {
  docker(['rm', '-f', NAME], { stdio: 'ignore' })
  console.log(`${NAME} removed`)
}

const cmd = process.argv[2]
if (cmd === 'up') await up()
else if (cmd === 'down') down()
else {
  console.error('usage: test-db.mjs up|down')
  process.exit(2)
}
