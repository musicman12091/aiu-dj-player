// The WebGL/canvas visualizer was removed in THADEUS-009.
// This command now runs the deck-shell checks (no canvas, no direct-stream
// warning, manifest + service worker present).
//   node tools/verify-visualizer.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(process.execPath, ['--test', join(root, 'tools/deck-shell.test.mjs')], {
  stdio: 'inherit',
  cwd: root
});
process.exit(result.status === null ? 1 : result.status);
