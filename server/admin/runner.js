import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { cloud, tenantEnv, writeTenantEnv } from './store.js';
import { paths, repoRoot } from './paths.js';

/**
 * Starts and stops tenants. Two ways, chosen in the multi-tenant settings (runner):
 * - process: each tenant is a systemd user service (systemd-run), with memory, CPU and process-count limits from its
 *   cgroup. Needs no root, so it runs on the home VM. All tenants run as the same Linux user, so this keeps them
 *   apart by their own data folders and ports, not by the operating system.
 * - docker: each tenant is a container (selah:<release>) with its data folders mounted, the same limits, a read-only
 *   file system, no capabilities and its ports published only on 127.0.0.1. The cloud server uses this.
 * Either way Caddy reaches the tenant on 127.0.0.1:<port>, and the admin console on 127.0.0.1:<control port>.
 */

const httpError = (code, message) => Object.assign(new Error(message), { statusCode: code });
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

/** The folder a release's code is in (no release: the code this console runs from). */
export const releaseDir = (release) => (release ? path.join(paths.releases, release) : repoRoot);

const processRunner = {
  kind: 'process',
  unit: (slug) => `${cloud().unitPrefix}-${slug}.service`,
  async start(t) {
    const dir = releaseDir(t.release);
    if (!fs.existsSync(path.join(dir, 'server', 'index.js'))) throw httpError(500, `Release ${t.release ?? '(this code)'} isn’t on the server.`);
    writeTenantEnv(t);
    const unit = this.unit(t.slug);
    await run('systemctl', ['--user', 'stop', unit]);
    await run('systemctl', ['--user', 'reset-failed', unit]);
    const l = t.limits;
    const r = await run('systemd-run', [
      '--user', `--unit=${unit}`, `--description=Selah tenant ${t.slug}`, '--collect', '--quiet',
      `--working-directory=${dir}`, `--property=EnvironmentFile=${paths.tenant(t.slug).env}`,
      `--property=MemoryMax=${l.memoryMb}M`, `--property=CPUQuota=${l.cpuPercent}%`, `--property=TasksMax=${l.tasks}`,
      '--property=Restart=on-failure', '--property=RestartSec=3', '--property=NoNewPrivileges=yes', '--property=UMask=0077',
      process.execPath, 'server/index.js',
    ]);
    if (!r.ok) throw httpError(500, `Couldn’t start ${t.slug}: ${r.stderr.trim() || r.code}`);
  },
  async stop(t) {
    await run('systemctl', ['--user', 'stop', this.unit(t.slug)]);
  },
  /** active, activating, failed or inactive */
  async status(t) {
    const r = await run('systemctl', ['--user', 'is-active', this.unit(t.slug)]);
    return r.stdout.trim().split('\n')[0] || 'inactive';
  },
  /** How many times it has been restarted after crashing since it was started. */
  async restarts(t) {
    const r = await run('systemctl', ['--user', 'show', '-p', 'NRestarts', '--value', this.unit(t.slug)]);
    return Number(r.stdout.trim()) || 0;
  },
  async logs(t, lines = 200) {
    const r = await run('journalctl', ['--user', '-u', this.unit(t.slug), '-n', String(lines), '--no-pager', '-o', 'short-iso']);
    return r.stdout;
  },
};

const dockerRunner = {
  kind: 'docker',
  name: (slug) => `${cloud().unitPrefix}-${slug}`,
  image: (release) => `selah:${release ?? 'local'}`,
  async start(t) {
    const p = paths.tenant(t.slug);
    const envFile = path.join(p.dir, 'tenant.docker.env');
    writeTenantEnv(t); // kept for the record and the CLI
    fs.writeFileSync(envFile, tenantEnv(t, { docker: true }), { mode: 0o600 });
    const name = this.name(t.slug);
    await run('docker', ['rm', '-f', name]);
    const l = t.limits;
    const r = await run('docker', [
      'run', '-d', '--name', name, '--restart', 'unless-stopped', '--env-file', envFile,
      '-v', `${p.data}:/data/data`, '-v', `${p.storage}:/data/storage`,
      '-p', `127.0.0.1:${t.port}:8080`, '-p', `127.0.0.1:${t.controlPort}:8081`,
      '--memory', `${l.memoryMb}m`, '--memory-swap', `${l.memoryMb}m`, '--cpus', String(l.cpuPercent / 100), '--pids-limit', String(l.tasks),
      '--read-only', '--tmpfs', '/tmp:rw,size=256m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', `${process.getuid()}:${process.getgid()}`,
      this.image(t.release),
    ]);
    if (!r.ok) throw httpError(500, `Couldn’t start ${t.slug}: ${r.stderr.trim() || r.code}`);
  },
  async stop(t) {
    // Asked to stop first (Selah finishes what it's doing and closes its database), then removed.
    await run('docker', ['stop', '--time', '20', this.name(t.slug)]);
    await run('docker', ['rm', '-f', this.name(t.slug)]);
  },
  async status(t) {
    const r = await run('docker', ['inspect', '-f', '{{.State.Status}}', this.name(t.slug)]);
    const s = r.stdout.trim();
    return s === 'running' ? 'active' : s === 'restarting' ? 'activating' : s === 'exited' || s === 'dead' ? 'failed' : 'inactive';
  },
  async restarts(t) {
    const r = await run('docker', ['inspect', '-f', '{{.RestartCount}}', this.name(t.slug)]);
    return Number(r.stdout.trim()) || 0;
  },
  async logs(t, lines = 200) {
    const r = await run('docker', ['logs', '--tail', String(lines), '--timestamps', this.name(t.slug)]);
    return r.stdout + r.stderr;
  },
};

export const runner = () => (cloud().runner === 'docker' ? dockerRunner : processRunner);

/** For waitHealthy's failFast: a reason to stop waiting when the tenant keeps crashing as it starts. */
export const crashLoop = (t) => async () => ((await runner().restarts(t)) >= 2 ? 'it keeps stopping as it starts; see its log' : null);

/** Is Docker there and usable by this user? */
export async function dockerAvailable() {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
  return r.ok ? r.stdout.trim() : null;
}

export { run };
