import { stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname, dirname, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);

export function readCatalogue(html, sourcePath, outputPath) {
  const match = html.match(/<script>\s*const VIDEOS = ([\s\S]*?);\s*<\/script>/);
  if (!match) throw new Error('Refresh the library to create your channels.');
  const videos = JSON.parse(match[1]);
  if (!Array.isArray(videos) || videos.length > 100000) throw new Error('Invalid video library.');
  const tiers = new Set(['preschool', 'shared', 'big', 'older', 'grownup', 'music']);
  return videos.map(video => {
    const path = video.path || video.src;
    if (typeof path !== 'string' || !path || path.includes('\0') || /^[a-z][\w+.-]*:/i.test(path)
        || typeof video.src !== 'string' || !tiers.has(video.tier)) throw new Error('Invalid library entry.');
    return { src: video.src, path: relative(dirname(outputPath), resolve(dirname(sourcePath), path)),
      title: typeof video.title === 'string' ? video.title : '',
      channel: typeof video.channel === 'string' ? video.channel : '', tier: video.tier,
      duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0 };
  });
}

function safeJSON(value) { return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'); }

export async function prepareChannels(root, settings, userData) {
  // Import data only. Never execute a previously generated or user-selected HTML file.
  const exportToken = randomUUID();
  const output = join(userData, 'channels.html');
  const videos = readCatalogue(await readFile(settings.playerPath, 'utf8'), settings.playerPath, output);
  const [template, javascript] = await Promise.all([
    readFile(join(root, 'shuffler/player.html'), 'utf8'), readFile(join(root, 'shuffler/player.js'), 'utf8'),
  ]);
  let audiences = false;
  let audienceNames = {};
  try {
    const settings = JSON.parse(await readFile(join(userData, 'audiences.json'), 'utf8'));
    audiences = settings.enabled === true;
    // Households name their own adults; anything else in the file is ignored.
    if (settings.names && typeof settings.names === 'object') for (const id of ['mum', 'dad', 'both']) {
      const value = settings.names[id];
      if (typeof value === 'string' && value.trim()) audienceNames[id] = value.trim().slice(0, 40);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read audience settings.'); }
  let imported = {};
  try {
    const data = JSON.parse(await readFile(join(userData, 'player-import.json'), 'utf8'));
    for (const [key, value] of Object.entries(data)) {
      // Music and Everything learn under the audience's key now; their old keys are retired.
      if (/^kidshuffle\.(weights\.v2\.s(2|6|grown|mum|dad|both)|log\.v1|preferShort\.v1)$/.test(key)
          && typeof value === 'string') imported[key] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read imported preferences.'); }
  const seed = `try { if (!localStorage.getItem('onto.imported.v1')) {
    for (const [key,value] of Object.entries(${safeJSON(imported)})) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key,value);
    }
    localStorage.setItem('onto.imported.v1','1');
  } } catch (_) {}`;
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src file:; base-uri 'none'; form-action 'none'">`;
  const content = template.replace('<head>', '<head>\n' + policy)
    .replace('__PLAYER_JS__', 'window.ONTO_TASTE_TOKEN = ' + safeJSON(exportToken) + '; window.ONTO_AUDIENCES = ' + audiences + '; window.ONTO_AUDIENCE_NAMES = ' + safeJSON(audienceNames) + ';\n' + seed + '\n' + javascript).replace('__VIDEOS__', safeJSON(videos));
  await mkdir(userData, { recursive: true });
  const temporary = output + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, output);
  const catalogue = join(userData, 'library.json');
  const catalogueTemp = catalogue + '.' + randomUUID() + '.tmp';
  await writeFile(catalogueTemp, JSON.stringify({version:1, videos:videos.map(({path, ...video}) => video)}, null, 2) + '\n', {mode:0o600});
  await rename(catalogueTemp, catalogue);
  return { url: pathToFileURL(output).href, count: videos.length, exportToken };
}

export async function playerExists(settings) {
  if (extname(settings.playerPath).toLowerCase() !== '.html') return false;
  try { return (await stat(settings.playerPath)).isFile(); } catch { return false; }
}

export function generatorArgs(root, settings) {
  const args = [join(root, 'shuffler', 'make_shuffler.py'), '--library', settings.library,
    '--output', settings.playerPath];
  if (settings.sourcesPath) args.push('--sources', settings.sourcesPath);
  else args.push('--no-sources');
  if (settings.tiersPath) args.push('--tiers', settings.tiersPath);
  return args;
}

export async function buildPlayer(root, settings, runner = execute) {
  try {
    const { stdout } = await runner('python3', generatorArgs(root, settings), {
      timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env: process.env,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(error.code === 'ENOENT'
      ? 'Python 3 is required to build the player. Install Python 3 and FFmpeg first.'
      : String(error.stderr || error.message).trim().slice(-1800));
  }
}
