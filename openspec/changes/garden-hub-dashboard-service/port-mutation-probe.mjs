import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const variant = process.argv[2] ?? 'numeric';
const values = { numeric: '51235', colon: '127.0.0.1:51235', equals: 'port=51235', 'numeric-short': '80', 'colon-short': '127.0.0.1:80', 'equals-short': 'port=80' };
if (!(variant in values)) throw new Error('unknown fixture variant');
const fixture = mkdtempSync(join(tmpdir(), 'ghub-svc003-mutation-'));
try {
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  cpSync(join(process.cwd(), 'tools', 'service'), join(fixture, 'tools', 'service'), { recursive: true });
  cpSync(join(process.cwd(), 'tools', 'ghub-service.test.mjs'), join(fixture, 'tools', 'ghub-service.test.mjs'));
  const templatePath = join(fixture, 'tools', 'service', 'com.anima.garden-hub-dashboard.plist.template');
  const template = readFileSync(templatePath, 'utf8');
  const marker = '<key>GHUB_DASHBOARD_PORT</key>';
  if (!template.includes(marker)) throw new Error('fixture marker missing');
  writeFileSync(templatePath, template.replace(marker, `<key>OTHER_PORT</key>\n    <string>${values[variant]}</string>\n    ` + marker));
  const env = { ...process.env };
  delete env.GHUB_DASHBOARD_PORT;
  const run = spawnSync(process.execPath, ['--test', '--test-name-pattern=SVC-003', 'tools/ghub-service.test.mjs'], { cwd: fixture, env, encoding: 'utf8' });
  console.log(`fixture ${variant} contains extra port: true`);
  console.log(`mutated fixture test exit status: ${run.status}`);
  const detected = run.status !== 0 && run.stdout.includes('unexpected extra port values');
  console.log(`extra port assertion detected mutation: ${detected}`);
  if (!detected) process.exitCode = 1;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
