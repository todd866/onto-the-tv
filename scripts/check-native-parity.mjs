// Run the affected headless surfaces sequentially to keep worker load bounded.
import { spawnSync } from 'node:child_process';
for (const script of ['check-native-channels.mjs', 'test-ui.mjs', 'test-library-ui.mjs', 'test-ambient-ui.mjs', 'test-report-ui.mjs', 'check-tv-ui.mjs']) {
  const result = spawnSync(process.execPath, [new URL(script, import.meta.url).pathname], {
    stdio: 'inherit', env: { ...process.env, TV_UI_OUTPUT: 'audit/tv-parity' },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
