import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArtistTitleFromVideo, youtubeIdOf } from './music-pick.js';

// Music-video likes go into the one per-listener taste log shared with Glancebar and the 6IAN radio
// (Glancebar tools/music-store/musicstore.py append; docs/music-unify.md there). The TV is a household
// screen: its likes are the household's (listener household-tv) unless a single viewer is mapped to a
// listener in settings.musicTasteListeners. Fire and forget: a like never waits on, or fails because of,
// the log; with no tool installed nothing is written.
export const DEFAULT_MUSIC_STORE_TOOL = join(homedir(), 'Projects/glancebar/tools/music-store/musicstore.py');

export function tasteListenerFor(viewers, map = {}) {
  const ids = (Array.isArray(viewers) ? viewers : String(viewers ?? '').split(','))
    .map(id => String(id).trim().toLowerCase()).filter(Boolean);
  return (ids.length === 1 && map[ids[0]]) || 'household-tv';
}

export function tasteArgs({ item, liked, viewers, listeners }) {
  if (!item || item.tier !== 'music') return null;
  const { artist, title } = parseArtistTitleFromVideo(item);
  const youtube = youtubeIdOf(item);
  if (!youtube && !(artist && title)) return null;
  const args = ['append', '--listener', tasteListenerFor(viewers, listeners), '--app', 'onto-the-tv',
    '--kind', liked ? 'like' : 'unlike', '--flush'];
  if (youtube) args.push('--youtube', youtube);
  if (artist && title) args.push('--artist', artist, '--title', title);
  return args;
}

export function createTasteAppender({ tool = DEFAULT_MUSIC_STORE_TOOL, python = '/opt/homebrew/bin/python3',
  listeners = {}, log = () => {}, run = execFile, exists = existsSync } = {}) {
  const enabled = Boolean(tool) && exists(tool) && exists(python);
  return function record({ item, liked, viewers }) {
    if (!enabled) return false;
    const args = tasteArgs({ item, liked, viewers, listeners });
    if (!args) return false;
    try {
      run(python, [tool, ...args], { timeout: 60_000 }, error => {
        if (error) log(`taste log: ${error.message.split('\n')[0]}`);
      });
    } catch (error) {
      log(`taste log: ${error.message}`);
    }
    return true;
  };
}
