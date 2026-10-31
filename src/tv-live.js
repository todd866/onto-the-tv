// Free-to-air through the Samsung's own tuner. Tuning switches the TV off the
// Mac's HDMI input; while live TV shows, the remote still talks to the Mac, which
// passes channel and volume keys on, and Home or Back switches the TV back.

// Keys that mean the same on the TV whatever is showing.
const ALWAYS = { AudioVolumeUp: 'KEY_VOLUP', AudioVolumeDown: 'KEY_VOLDOWN', AudioVolumeMute: 'KEY_MUTE' };
// Keys passed on only while live TV is showing.
const LIVE = { ArrowUp: 'KEY_CHUP', ArrowDown: 'KEY_CHDOWN', PageUp: 'KEY_CHUP', PageDown: 'KEY_CHDOWN',
  Enter: 'KEY_ENTER', ...Object.fromEntries([...'0123456789'].map(d => [d, `KEY_${d}`])) };

export function tuneKeys(lcn) {
  const digits = String(lcn).trim();
  if (!/^\d{1,4}$/.test(digits)) throw new Error(`Not a channel number: ${lcn}`);
  return [...digits].map(d => `KEY_${d}`).concat('KEY_ENTER');
}

/** `remote` is a createSamsungRemote; `macInput` the key that selects the Mac's HDMI input. */
export function createLiveTv({ remote, macInput = 'KEY_HDMI' }) {
  let showing = null;   // the channel number on screen, or null when the TV shows the Mac

  async function tune(lcn) {
    const keys = tuneKeys(lcn);
    await remote.press(...(showing === null ? ['KEY_TV', ...keys] : keys));
    showing = String(lcn);
  }

  async function leave() {
    if (showing === null) return false;
    showing = null;
    await remote.press(macInput);
    return true;
  }

  /** Pass a remote key on to the TV if it means something there now. Returns whether it did. */
  function relay(key) {
    const tvKey = ALWAYS[key] || (showing !== null ? LIVE[key] : undefined);
    if (!tvKey) return false;
    remote.press(tvKey).catch(() => {});
    return true;
  }

  return { tune, leave, relay, get showing() { return showing; } };
}
