#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { MediaServer } from './server.js';
import { SamsungRenderer } from './renderer.js';
import { prepareMedia } from './pipeline.js';
import { nextQueueAction } from './playlist.js';

const USAGE = `SamsungTV Cast — send local files or YouTube URLs to the UA65MU8000 over DLNA.

Usage:
  node casting/src/cli.js diagnose
  node casting/src/cli.js status
  node casting/src/cli.js cast <file-or-youtube-url> [--dry-run] [--force]
  node casting/src/cli.js queue <file> [file...]
  node casting/src/cli.js pause | resume | stop
  node casting/src/cli.js seek <seconds>

This uses the TV's built-in network player, not the Tizen YouTube app.
Art Tracks are detected and played as audio so they cannot trigger the
YouTube "buffering timeout" crash.

Environment:
  SAMSUNG_TV_HOST     required: TV hostname or IPv4 address
  SAMSUNG_CAST_BIND   optional: laptop address reachable by the TV
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { force: false, dryRun: false };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--force') flags.force = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--tv-host') flags.tvHost = args[++i];
    else if (arg === '--bind') flags.bind = args[++i];
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else positional.push(arg);
  }
  return { command: positional[0], rest: positional.slice(1), flags };
}

async function commandExists(path) {
  try {
    for (const candidate of path.includes('/') ? [path] : (process.env.PATH || '').split(delimiter).map((dir) => join(dir, path))) {
      try { await access(candidate, fsConstants.X_OK); return true; } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function renderer(config) {
  return new SamsungRenderer({ avTransportUrl: config.avTransportUrl });
}

async function diagnose(config) {
  const lines = [];
  lines.push(`TV host:    ${config.tvHost}`);
  lines.push(`Bind host:  ${config.bindHost}`);
  lines.push(`AVTransport ${config.avTransportUrl}`);
  lines.push(`ffmpeg:     ${config.ffmpeg} ${(await commandExists(config.ffmpeg)) ? 'ok' : 'MISSING'}`);
  lines.push(`ffprobe:    ${config.ffprobe} ${(await commandExists(config.ffprobe)) ? 'ok' : 'MISSING'}`);
  lines.push(`yt-dlp:     ${config.ytdlp} ${(await commandExists(config.ytdlp)) ? 'ok' : 'MISSING'}`);

  try {
    const info = await renderer(config).transportInfo();
    lines.push(`Renderer:   ${info.state} / ${info.status}`);
    lines.push('DLNA control is reachable. Play will replace whatever is on screen.');
  } catch (error) {
    lines.push(`Renderer:   unreachable (${error.message})`);
    lines.push('If the TV is on, macOS may be blocking Local Network access for Terminal.');
  }
  return lines.join('\n');
}

async function status(config) {
  const tv = renderer(config);
  const [transport, position] = await Promise.all([tv.transportInfo(), tv.positionInfo()]);
  const pos = position.positionSeconds ?? '?';
  const dur = position.durationSeconds ?? '?';
  return [
    `state:    ${transport.state}`,
    `status:   ${transport.status}`,
    `position: ${pos}s / ${dur}s`,
    `uri:      ${position.uri || '(none)'}`,
  ].join('\n');
}

async function cast(source, config) {
  if (!source) throw new Error('cast requires a file path or YouTube URL');
  if (!config.dryRun && !config.force) {
    throw new Error('Casting replaces whatever is on the TV, including YouTube. Re-run with --force when that is okay, or use --dry-run to serve without touching the TV.');
  }
  const prepared = await prepareMedia(source, config, { log: console.error });
  const server = new MediaServer({ host: config.bindHost });
  await server.listen();
  const item = server.serveFile(prepared);
  console.error(`Serving ${item.url}`);
  console.error(`Title: ${prepared.title}${prepared.isArtTrack ? ' [Art Track → audio]' : ''}`);

  if (config.dryRun) {
    console.error('Dry run: not sending Play to the TV. Press Ctrl+C to stop the server.');
    await waitForExit(async () => {
      await server.close();
      await prepared.cleanup();
    });
    return 'dry-run ready';
  }

  const tv = renderer(config);

  try {
    await tv.play(item);
    console.error('TV Play sent. Leave this process running so the laptop can keep serving the file.');
    console.error('Ctrl+C stops the server; the TV will lose the stream.');
    await waitForExit(async () => {
      try { await tv.stop(); } catch {}
      await server.close();
      await prepared.cleanup();
    });
    return 'stopped';
  } catch (error) {
    await server.close();
    await prepared.cleanup();
    throw error;
  }
}

async function queue(sources, config) {
  if (!sources.length) throw new Error('queue requires at least one file path');
  if (!config.force) throw new Error('Queue playback replaces what is on the TV. Add --force when you want to start it.');
  const tv = renderer(config);
  const server = new MediaServer({ host: config.bindHost });
  await server.listen();
  const prepared = [];
  try {
    for (const source of sources) {
      const media = await prepareMedia(source, config, { log: console.error });
      const item = server.serveFile(media);
      prepared.push({ ...media, ...item });
      console.error(`Queued ${item.title} (${Math.round(media.durationSeconds || 0)}s) ${item.url}`);
    }
  } catch (error) {
    await server.close();
    await Promise.all(prepared.map((item) => item.cleanup?.()));
    throw error;
  }

  let armedIndex = -1;
  let stopping = false;
  const cleanup = async () => {
    stopping = true;
    await server.close();
    await Promise.all(prepared.map((item) => item.cleanup?.()));
  };

  console.error('Queue is live. This process must stay running to serve the files.');
  const exit = waitForExit(cleanup);

  while (!stopping) {
    let transport;
    let position;
    try {
      [transport, position] = await Promise.all([tv.transportInfo(), tv.positionInfo()]);
    } catch (error) {
      console.error(`TV poll failed: ${error.message}`);
      await sleep(3000);
      continue;
    }
    const action = nextQueueAction({
      queue: prepared,
      armedIndex,
      currentUri: position.uri,
      state: transport.state,
    });
    try {
      if (action.type === 'arm') {
        await tv.setNext(prepared[action.index]);
        armedIndex = action.index;
        console.error(`Next up: ${prepared[action.index].title}`);
        if (transport.state === 'PAUSED_PLAYBACK') {
          await tv.resume();
          console.error('Resumed current playback.');
        }
      } else if (action.type === 'play') {
        await tv.play(prepared[action.index]);
        armedIndex = action.index;
        console.error(`Playing ${prepared[action.index].title}`);
      }
    } catch (error) {
      console.error(`Queue action failed: ${error.message}`);
    }
    await Promise.race([sleep(2000), exit]);
  }
  await exit;
  return 'queue stopped';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(cleanup) {
  return new Promise((resolve) => {
    const finish = async () => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      await cleanup();
      resolve();
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
}

export async function main(argv = process.argv) {
  const { command, rest, flags } = parseArgs(argv);
  if (!command || flags.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig(process.env, flags);
  switch (command) {
    case 'diagnose':
      console.log(await diagnose(config));
      return 0;
    case 'status':
      console.log(await status(config));
      return 0;
    case 'cast':
      console.log(await cast(rest[0], config));
      return 0;
    case 'queue':
      console.log(await queue(rest, config));
      return 0;
    case 'pause':
      await renderer(config).pause();
      return 0;
    case 'resume':
      await renderer(config).resume();
      return 0;
    case 'stop':
      await renderer(config).stop();
      return 0;
    case 'seek':
      await renderer(config).seek(Number(rest[0]));
      return 0;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
