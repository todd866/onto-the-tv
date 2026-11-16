import { createTvCommands } from './tv-commands.js';
import { liveManifest } from './tv-live.js';
import { createPlayNext } from './play-next.js';
import { createServer } from 'node:http';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { isIP } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readCatalogue } from './shuffler.js';
import { writeAtomically } from './atomic-write.js';
import { createDiagnosticsStore } from './tv-diagnostics.js';
import { createGameRelay } from './game-relay.js';
import { createConsoleLauncher } from './console-launcher.js';
import { createConfiguredUkeHandler } from './uke-handler.js';
import { adDecade, buildPlayQueue, isAdSrc } from './ads.js';
import { listSidecars, readSubtitle } from './subtitles.js';
import { libraryView, showsView } from './tv-library-api.js';
import { catalogueStatus, libraryHealthReport } from './library.js';

// The TV pulls from this server: it lists the library, picks each channel's next
// episode with the same picker and learning rules as the app's player, and streams
// the files. It is meant for a home network; requests from public addresses are refused.

const require = createRequire(import.meta.url);
const player = require('../shuffler/player.js');

// One list, so a household can rename people without hunting through the UI.
// `ceiling` is the highest rating that person may watch; null means an adult.
export const TV_VIEWERS = [
  { id: 'sam', name: 'Sam', ceiling: 'G' },
  { id: 'jake', name: 'Jake', ceiling: 'PG' },
  { id: 'mum', name: 'Fran', ceiling: null },
  { id: 'dad', name: 'Ian', ceiling: null },
];

const RATING_ORDER = ['G', 'PG', 'PG-13', 'M'];
// Folder tiers from the shuffler. Decades are the 50s–90s source tiers.
export const TIER_RATINGS = {
  preschool: 'G', shared: 'G', music: 'G',
  big: 'PG',
  older: 'PG-13',
  grownup: 'M', couple: 'M', adultanim: 'M', sitcom: 'M', scifi: 'M',
  comedy: 'M', docs: 'PG', classic: 'M', sports: 'PG', bbc: 'M', standup: 'M',
  '50s': 'M', '60s': 'M', '70s': 'M', '80s': 'M', '90s': 'M',
};

// Genre channels. Numbers stay put when a channel is hidden, so key 1 is always
// Cartoons. Games (6) and Uke (7) are added by the TV page, not the library.
// Cartoons: kids' shows plus adult animation. Movies: films only (Films and
// Family Films). Mum & Dad (21): grown-up and couple TV, in episode order.
// Sitcoms, music and Christmas keep the folders and the seasonal filter they
// already had.
const CARTOON_TIERS = new Set(['preschool', 'shared', 'big', 'older']);
const KID_TIERS = CARTOON_TIERS;
// Grown-up tiers a personal channel ("For Dad") draws from.
const PERSONAL_TIERS = new Set(['grownup', 'couple', 'sitcom', 'scifi', 'adultanim', 'comedy', 'docs', 'classic', 'bbc', 'standup', 'sports',
  '50s', '60s', '70s', '80s', '90s']);
const GROWNUP_TV_TIERS = new Set(['grownup', 'couple']);
// A film is anything in a film folder, whatever its tier; the rating ceiling
// still decides who sees it. (player.inStream('movies') only admits family tiers.)
// Grown-up films are filed one folder per film, "In Bruges (2008)", so a grown-up
// folder named with a year whose file carries no episode marker is a film too.
const FILM_FOLDERS = new Set(['Films', 'Family Films']);
const YEAR_FOLDER = /\((?:19|20)\d\d\)\s*$/;
const EPISODE_MARK = /\bS\d{1,2}\s?E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i;
const isFilm = item => FILM_FOLDERS.has(item.channel)
  || (GROWNUP_TV_TIERS.has(item.tier) && YEAR_FOLDER.test(String(item.channel || ''))
    && !EPISODE_MARK.test(String(item.src || '')));
const DECADES = { d50: '50s', d60: '60s', d70: '70s', d80: '80s', d90: '90s' };
// Numbers 6 and 7 are Games and Uke on the TV. Decade channels carry period ads.
// Sports is the taped-broadcast channel: its files are scanned for ad breaks.
// `audience` orders the home screen: a grown-up audience sees its own channels first,
// a child's audience sees the kids' channels first; numbers never move.
// `shows` channels pick named show folders; the rating still comes from each file's tier.
// `person` channels are one adult's own mix, picked by that adult's learned taste.
export const TV_CHANNELS = [
  { id: 'cartoons', number: 1, name: 'Cartoons', audience: 'kid' },
  { id: 'movies', number: 2, name: 'Movies', audience: 'adult' },
  { id: 'sitcoms', number: 3, name: 'Sitcoms', audience: 'adult' },
  { id: 'music', number: 4, name: 'Music', audience: 'all' },
  { id: 'christmas', number: 5, name: 'Christmas', audience: 'all' },
  { id: 'comedy', number: 8, name: 'Comedy', audience: 'adult' },
  { id: 'docs', number: 9, name: 'Sport & Docs', audience: 'adult' },
  { id: 'scifi', number: 10, name: 'Sci-Fi', audience: 'adult' },
  { id: 'classic', number: 11, name: 'Classics', audience: 'adult' },
  { id: 'd50', number: 12, name: '1950s', ads: '50s', audience: 'adult' },
  { id: 'd60', number: 13, name: '1960s', ads: '60s', audience: 'adult' },
  { id: 'd70', number: 14, name: '1970s', ads: '70s', audience: 'adult' },
  { id: 'd80', number: 15, name: '1980s', ads: '80s', audience: 'adult' },
  { id: 'd90', number: 16, name: '1990s', ads: '90s', audience: 'adult' },
  { id: 'sports', number: 17, name: 'Sports', recordedAds: true, audience: 'all' },
  { id: 'hophop', number: 18, name: 'Hop Hop', audience: 'kid' },
  { id: 'rides', number: 19, name: 'Rides & Adventures', rating: 'PG', audience: 'all' },
  { id: 'fordad', number: 35, name: 'For Ian', person: 'dad', audience: 'adult' },
  { id: 'grownups', number: 21, name: 'Ian & Fran', audience: 'adult' },
  { id: 'littleones', number: 22, name: 'Little Ones', audience: 'kid', kids: true,
    shows: /^(?:bing|peppa pig|play school|cbeebies bedtime|charlie and lola|sarah and duck|jojo and gran gran|fireman sam|hey duggee|cocomelon|nick jr|in the night garden|teletubbies|ms ?rachel)/i },
  { id: 'bluey', number: 23, name: 'Bluey', audience: 'kid', kids: true, shows: /^bluey\b/i },
  { id: 'adventures', number: 24, name: 'Adventures', audience: 'kid', kids: true,
    shows: /^(?:octonauts|kangaroo beach|go jetters|curious george|paw patrol|the wiggles)/i },
  { id: 'learn', number: 25, name: 'Learn', audience: 'kid', kids: true,
    shows: /^(?:numberblocks|alphablocks|colourblocks|scishow kids|national geographic kids|maddie moate|blippi|lego builds|sesame street|storybots)/i },
  { id: 'shorts', number: 26, name: 'Shorts & Sillies', audience: 'kid', kids: true,
    shows: /^(?:shaun the sheep|pixar shorts|looney tunes|timmy time|mr bean)/i },
  { id: 'trains', number: 27, name: 'Trains, Planes & Cars', audience: 'kid', kids: true,
    shows: /^(?:track time|billy.s aviation|hot wheels|bob the builder|blaze|thomas (?:&|and) friends)/i },
  { id: 'friends', number: 28, name: 'Friends', audience: 'adult', shows: /^friends\b/i },
  { id: 'seinfeld', number: 29, name: 'Seinfeld', audience: 'adult', shows: /^seinfeld\b/i },
  { id: 'adultanim', number: 30, name: 'Grown-up Cartoons', audience: 'adult' },
  { id: 'crime', number: 31, name: 'Crime & Mystery', audience: 'adult',
    shows: /^(?:miss fisher|shetland|vera\b|death in paradise|midsomer|the bill|rake|jack irish|wire in the blood|line of duty|broadchurch|poirot|agatha christie|sherlock|lewis|inspector)/i },
  { id: 'truecrime', number: 32, name: 'True Crime', audience: 'adult',
    shows: /^(?:48 hours|exposed|lindsay clancy|dateline|australian story|four corners)/i },
  { id: 'reality', number: 33, name: 'Reality', audience: 'adult',
    shows: /^(?:(?:couples )?come dine with me|grand designs|gogglebox|masterchef|the block|location|escape to)/i },
  { id: 'formum', number: 34, name: 'For Fran', person: 'mum', audience: 'adult' },
  { id: 'forjake', number: 36, name: 'For Jake', person: 'jake', audience: 'kid' },
  // Ian's shelf (6 Nov 2026): channels a 40-year-old ex-RAAF pilot reaches for. Each appears
  // once a folder matching it lands on the drive; folder names must start with the show's name.
  { id: 'thrillers', number: 37, name: 'Spy & Crime', audience: 'adult',
    shows: /^(?:mobland|slow horses|reacher|line of duty|the night manager|jack ryan|peaky blinders|the sopranos|the wire\b|breaking bad|ozark|narcos|the bureau|bodyguard|gangs of london|the gentlemen (?!\()|the day of the jackal|the terminal list|tom clancy|bosch|sherlock|jack irish|rake\b)/i },
  { id: 'military', number: 38, name: 'War & Military', audience: 'adult',
    shows: /^(?:band of brothers|the pacific|generation kill|das boot|masters of the air|chernobyl|the world at war|world war|ww ?(?:1|2|i|ii)\b|vietnam|the operations room|task (?:&|and) purpose|forces news|warographics|the last kingdom|sas rogue heroes|sas:? rogue heroes|our war|the war that changed us)/i },
  { id: 'aviation', number: 39, name: 'Aviation', audience: 'adult',
    shows: /^(?:mayday|air crash investigation|air disasters|mentour|air safety institute|eaa\b|blancolirio|juan browne|74 gear|ward carroll|cargospotter|dutchpilotgirl|top gun|the right stuff|airshow|red bull air race|nasa)/i },
  { id: 'motoring', number: 40, name: 'Cars & Motoring', audience: 'adult',
    shows: /^(?:top gear|the grand tour|clarkson|wheeler dealers|car sos|doug ?demuro|hoovie|jay leno|vehicle virgins|cleetus|engineering explained|grand tour)/i },
  { id: 'makers', number: 41, name: 'Makers & Explainers', audience: 'adult',
    shows: /^(?:mark rober|johnny harris|veritasium|smarter every ?day|real engineering|wendover|practical engineering|stuff made here|colin furze|kurzgesagt|half as interesting|tom scott|the b1m|outdoor boys|abandoned|restoration|my mechanics|hand tool rescue)/i },
  { id: 'livesets', number: 42, name: 'Live Sets', audience: 'adult',
    shows: /^(?:tiny desk|like a version|cercle|kexp|boiler room|from the basement|bbc live|colors|mahogany|audiotree|live at)/i },
  // The radio stations are the grown-ups' (Ian, 15 Nov 2026: "Sam loves music but he doesn't necessarily need
  // separate triple J and double J categories"): with a child in the room their songs are still on Music.
  { id: 'triplej', number: 43, name: 'triple j', audience: 'adult', scored: true, adultsOnly: true },
  { id: 'doublej', number: 44, name: 'Double J', audience: 'adult', scored: true, adultsOnly: true },
  // Sam's music (same day): "He probably likes kids music, and he definitely loves any kinda danceable techno
  // type stuff, but simple stuff with flashing lights is probably his jam." Songs is children's music, by show
  // or by a title that says so. Dance is the house, techno and other four-on-the-floor acts in the music
  // folders; a measured score (channel-scores "dance": steady beat, flashing lights, simple picture) leans the
  // picks without deciding who is on the channel.
  { id: 'kidsongs', number: 45, name: 'Songs', audience: 'kid', kids: true,
    shows: /^(?:the wiggles|ms ?rachel|emma memma|teeny tiny stevies|super simple songs|justine clarke|lah-?lah|play school songs|bounce patrol|danny go|the kiboomers|little baby bum|mother goose club|cocomelon)/i,
    titles: /\b(?:songs|nursery rhymes?|sing[- ]?along|lullab(?:y|ies)|karaoke|song contest)\b/i },
  { id: 'dance', number: 46, name: 'Dance', audience: 'kid', tier: 'music', leaning: true,
    shows: /^(?:20syl|amtrac|anjunadeep|avicii|axel thesleff|barry can.t swim|ben b[oö]hmer|bicep|big wild|bob moses|bonobo|bronson|bunt|calvin harris|camelphat|caribou|cercle|cerrone|channel tres|chris lake|christian l[oö]ffler|confidence man|cosmo.s midnight|cri|cut copy|darius|daso|diplo|disclosure|dj poolboi|dom dolla|ed banger records|ekcle|elderbrook|eliza rose|enamour|eric prydz|fatboy slim|fcukers|fisher|flight facilities|floating points|flume|four tet|franc moody|frankie knuckles|fred again|french 79|future classic|gener8ion|groove armada|howling|jakatta|jamie xx|jon hopkins|jungle|jungle4eva|justice|kaskade|kaytramin[eé]|kaytranada|kid francescoli|kidnap|klangkarussell|lane 8|lcd soundsystem|le youth|lf system|louis the child|maribou state|marsh|mau p|minimal groove|moby|modjo|m[oø]me|mura masa|new order|nils hoffmann|nimino|nto|odesza|omnom|parcels|parisi|parra for cuva|paul woolford|pauloakenfold|peggy gou|petit biscuit|pnau|polo & pan|porter robinson|rezident|rone|ross from friends|r[uü]f[uü]s du sol|sachi|sammy virji|shallou|snakehips|swedish house mafia|switch disco|teed|the avalanches|the blaze|the chemical brothers|the orb|thylacine|todd terje|tourist|vantage|what so not|whethan|wuki|young franco|yung bae|zhu)(?![a-z0-9])/i },
];
// Fran's own mix, from Ian (4 Nov 2026): her top three are Come Dine With Me, Friends and The
// Big Bang Theory, and she is a big fan of British reality TV; she likes Kath & Kim too. No animation, no violence.
const MUM_TIERS = new Set(['grownup', 'couple', 'sitcom', 'comedy', 'bbc', 'standup', 'docs']);
const MUM_SKIPS = /^(?:mobland|snatch|lock stock|the gentlemen|in bruges)\b/i;
// Familiar shows draw people in (Ian): her favourites lead the channel, everything else on it
// is a low-weight discovery. Per show: 4 against 0.3, so favourites win about three picks in four.
const FAVOURITE_WEIGHT = 4, DISCOVERY_WEIGHT = 0.3;
const FRAN_SHOWS = /^(?:(?:couples )?come dine with me|bald and bankrupt|friends\b|kath (?:&|and) kim|the big bang theory|big bang theory|gogglebox|first dates|four in a bed|the great british bake off|great british bake off|bake off|escape to the country|a place in the sun|location,? location|the hotel inspector|24 hours in a&e|married at first sight uk|love island|the apprentice|dragons.? den|grand designs|bargain hunt|homes under the hammer|the traitors|race across the world|the repair shop)/i;
// Jake's own mix (Ian, 4 Nov 2026): he loves Minecraft, and cars (Track Time); he will watch
// Bluey but is not in love with it. Shouty YouTuber channels stay off.
const JAKE_TIERS = new Set(['shared', 'big', 'older']);
const JAKE_SHOWS = /minecraft|grian|mumbo|hermitcraft|pixlriffs|track time|hot wheels|\bcars?\b|lego|\brc\b|odyssey|remote control/i;
// Jake's card and the next picks walk this list: Minecraft, then Track Time, then cars, then RC.
function jakeLeadRank(name) {
  const text = String(name || '');
  if (/minecraft/i.test(text)) return 0;
  if (/track time/i.test(text)) return 1;
  if (/hot wheels|\bcars?\b|lego/i.test(text)) return 2;
  if (/odyssey|\brc\b|remote control/i.test(text)) return 3;
  return 4;
}
// Shows the kids love that the parents would rather ration (Ian, 4 Nov 2026): the plane-crash
// cartoons ("If Planes Could Talk"), and YouTube slop in general ("he *loves* a bit of youtube
// slop, we kinda hate it, so use it sparingly"). Fine to watch, rarely picked, and never billed
// as a card's "now on" while the channel has anything else.
const LIMITED_SHOWS = new RegExp(['billy.s aviation', 'if planes could talk', 'plane crash', 'air crash', 'mayday',
  'brent rivera', 'ben azelart', 'stephen sharer', 'carter sharer', 'unspeakable', 'stokes twins', 'beck ?bro', 'vlad and niki',
  'kids diana', 'waffloos', 'lincoln.s super', 'mrbeast', 'try not to laugh', 'ytp',
  // Added 6 Nov 2026 from real viewing: Peppa-theory clickbait, kitten-gadget and challenge channels.
  'cinewave', 'daniel ?ferri', 'stay ?wild'].join('|'), 'i');
const LIMITED_WEIGHT = 0.05;
// Ian (5 Nov 2026: "think about what a 40 year old ex-military dude might want"): ex-RAAF
// pilot. British crime and gangster films, Mobland-style drama, Star Trek, Futurama and South
// Park, dry Aussie comedy (Utopia, Hard Quiz, Gruen), Blackadder, and the wishlist's aviation,
// military, motoring, maker and live-music long-form as it lands. No cosy murder mysteries.
const IAN_SHOWS = new RegExp('^(?:' + ['mobland', 'the gentlemen', 'snatch', 'lock,? stock', 'in bruges', 'rocknrolla',
  'star trek', 'the orville', 'the expanse', 'futurama', 'south park', 'utopia', 'fisk', 'hard quiz', 'gruen', 'blackadder',
  'taskmaster', 'have you been paying attention', 'qi\\b', 'would i lie to you', 'bald and bankrupt', 'top gear', 'the grand tour', 'band of brothers', 'the pacific',
  'generation kill', 'chernobyl', 'das boot', 'slow horses', 'line of duty', 'reacher', 'jack ryan', 'the night manager',
  'mayday', 'air crash investigation', 'top gun', 'black hawk down', 'dunkirk', 'apollo 13', 'master and commander',
  'heat\\b', 'sicario', 'mark rober', 'johnny harris', 'tiny desk', 'like a version', 'cercle', 'mentour', 'air safety institute',
  'peaky blinders', 'the sopranos', 'veritasium', 'smarter every ?day', 'real engineering', 'wendover', 'kexp'].join('|') + ')', 'i');
// Fran's lifestyle and reality shows: hers, not his (they share Bald and Bankrupt).
// Plus the cosy, old-person British murder mysteries (Ian, 6 Nov 2026: "keep that off my channel").
const IAN_SKIPS = /^(?:shetland|vera\b|death in paradise|miss fisher|midsomer|father brown|foyle|poirot|marple|agatha christie|lewis\b|endeavour|inspector|grantchester|murder,? she wrote|death on the nile|the madame blanc|whitstable pearl|the brokenwood|rosemary (?:&|and) thyme|bergerac|dalgliesh|ludwig|(?:couples )?come dine with me|first dates|a place in the sun|escape to the country|homes under the hammer|the hotel inspector|grand designs|dragons.? den|the repair shop|gogglebox|four in a bed|(?:the )?(?:great british )?bake off|bargain hunt|location,? location|love island|married at first sight|the apprentice)/i;
// Each person's favourites lead their own channel; the rest of its pool are discoveries.
const FAVOURITES = { mum: FRAN_SHOWS, jake: JAKE_SHOWS, dad: IAN_SHOWS };
// A grown-up on their own sees channels in the order they would reach for them; unlisted
// channels follow in catalogue order. Learned taste breaks ties within the rest.
const PERSON_LINEUP = {
  dad: ['fordad', 'movies', 'thrillers', 'military', 'aviation', 'motoring', 'makers', 'scifi', 'adultanim', 'comedy',
    'triplej', 'doublej', 'livesets', 'music', 'docs', 'sports', 'rides', 'sitcoms', 'seinfeld', 'classic', 'd80', 'd90', 'd70', 'truecrime',
    'grownups', 'crime', 'friends', 'reality'],
  mum: ['formum', 'reality', 'friends', 'sitcoms', 'grownups', 'truecrime', 'crime', 'comedy', 'music', 'seinfeld', 'movies'],
};
// After 7pm these sink below films, drama and documentaries.
const SHORT_CLIP_CHANNELS = new Set(['music', 'livesets', 'shorts', 'makers', 'comedy', 'triplej', 'doublej']);
// Episodic channels play the next episode; cartoons and music stay shuffled.
const SERIAL_CHANNELS = new Set(['movies', 'sitcoms', 'grownups', 'friends', 'seinfeld', 'crime', 'thrillers', 'military',
  'aviation', 'motoring', 'scifi', 'classic', 'truecrime', 'reality', 'docs']);
const RECENT_FINISH_MS = 30 * 24 * 60 * 60 * 1000;
const LONG_FORM_SECONDS = 20 * 60;
const CHANNEL_BY_ID = new Map(TV_CHANNELS.map(channel => [channel.id, channel]));

const RIDES_SHOWS = /\b(?:knight rider|the a[- ]team|the dukes of hazzard|airwolf|chips|baywatch|top gear)\b/i;

export function scoredRotationWeight(score) {
  const value = typeof score === 'number' ? score : Number(score);
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return 0.4 + 1.6 * clamped;
}

export function applyScoredChannelWeight(baseWeight, score) {
  return baseWeight * scoredRotationWeight(score);
}

// Parsed `channels` object from channel-scores.json; null when missing or unusable.
export function parseChannelScores(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const channels = parsed.channels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return null;
  const out = Object.create(null);
  for (const [channelId, channel] of Object.entries(channels)) {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) continue;
    const items = channel.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) continue;
    const cleaned = Object.create(null);
    for (const [src, meta] of Object.entries(items)) {
      if (typeof src !== 'string' || !meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      let score = meta.score;
      if (typeof score === 'string') score = Number(score);
      if (!Number.isFinite(score)) continue;
      cleaned[src] = { score: Math.min(1, Math.max(0, score)) };
    }
    if (Object.keys(cleaned).length) out[channelId] = { items: cleaned };
  }
  return Object.keys(out).length ? out : null;
}

// Several tools score channels (the stations' rotation, the measured Dance lights): each writes its own
// file, and a later file replaces an earlier one's channel whole.
export function mergeChannelScores(list) {
  const out = Object.create(null);
  for (const scores of list) if (scores) for (const [channelId, channel] of Object.entries(scores)) out[channelId] = channel;
  return Object.keys(out).length ? out : null;
}

export function whoamiProof(token, nonce) {
  return createHmac('sha256', token).update('onto-whoami:' + nonce).digest('hex');
}

export function channelScoresSignaturePart(path, info) {
  return `channel-scores:${path}:${info ? `${info.mtimeMs}:${info.size}` : 'missing'}`;
}

export function inTvGenre(item, channelId, scores = null) {
  if (!item || isAdSrc(item.src)) return false;
  if (channelId === 'christmas') return player.inStream(item, 'christmas');
  if (channelId === 'music') return item.tier === 'music';
  const defined = CHANNEL_BY_ID.get(channelId);
  if (defined?.scored) {
    if (!defined.kids && KID_TIERS.has(item.tier)) return false;
    const items = scores?.[channelId]?.items;
    if (!items) return false;
    return Object.hasOwn(items, item.src);
  }
  if (defined?.shows) {
    if (defined.kids && !KID_TIERS.has(item.tier)) return false;
    if (!defined.kids && KID_TIERS.has(item.tier)) return false;
    if (defined.tier && item.tier !== defined.tier) return false;
    if (isFilm(item)) return false;
    return defined.shows.test(String(item.channel || '').replace(/^[^\w]+/, '')) || Boolean(defined.titles?.test(String(item.title || '')));
  }
  if (defined?.person === 'jake') return JAKE_TIERS.has(item.tier) && !isFilm(item);
  if (defined?.person === 'mum') return MUM_TIERS.has(item.tier) && !isFilm(item) && !MUM_SKIPS.test(String(item.channel || ''));
  if (defined?.person === 'dad') return PERSONAL_TIERS.has(item.tier) && !isFilm(item) && !IAN_SKIPS.test(String(item.channel || ''));
  if (defined?.person) return PERSONAL_TIERS.has(item.tier) && !isFilm(item);
  if (channelId === 'sitcoms') return item.tier === 'sitcom' || item.tier === 'bbc';
  if (channelId === 'adultanim') return item.tier === 'adultanim' && !isFilm(item);
  if (channelId === 'movies') return isFilm(item);
  if (channelId === 'grownups') return GROWNUP_TV_TIERS.has(item.tier) && !isFilm(item);
  if (channelId === 'cartoons') return CARTOON_TIERS.has(item.tier) && !isFilm(item);
  if (channelId === 'comedy') return item.tier === 'comedy' || item.tier === 'standup';
  if (channelId === 'docs') return item.tier === 'docs';
  if (channelId === 'scifi') return item.tier === 'scifi';
  if (channelId === 'classic') return item.tier === 'classic';
  if (channelId === 'sports') return item.tier === 'sports';
  if (channelId === 'hophop') return ['preschool', 'shared'].includes(item.tier)
    && /hop[ ._-]?hop/i.test(String(item.channel || '') + ' ' + String(item.src || '').replace(/[._]/g, ' '));
  if (channelId === 'rides') return RIDES_SHOWS.test(
    (String(item.channel || '') + ' ' + String(item.src || '')).replace(/[._]/g, ' '));
  if (DECADES[channelId]) return item.tier === DECADES[channelId];
  return false;
}

export function countTvChannelVideos(videos, channelId, scores = null) {
  if (!Array.isArray(videos)) return 0;
  let count = 0;
  for (const item of videos) if (inTvGenre(item, channelId, scores)) count += 1;
  return count;
}

export function formatTvChannelPoolReport(videos) {
  const lines = [];
  for (const channel of TV_CHANNELS) {
    const count = countTvChannelVideos(videos, channel.id);
    const flag = count === 0 ? 'EMPTY' : count < 5 ? 'THIN' : '';
    const suffix = flag ? `  ${flag}` : '';
    lines.push(`  ${String(channel.number).padStart(2)}  ${channel.name.padEnd(20)} ${String(count).padStart(4)} videos${suffix}`);
  }
  return lines.join('\n');
}

export function fileWantsRecordedAds(item) {
  return TV_CHANNELS.some(channel => channel.recordedAds && inTvGenre(item, channel.id));
}

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t' };
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff': 'font/woff' };
const RECENT_LIMIT = 50;

/** True for loopback, private, link-local, CGNAT/Tailscale and unique-local addresses. */
export function isHomeAddress(address) {
  let value = String(address || '');
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(value) === 6) return value === '::1' || /^f[cd]/i.test(value) || /^fe[89ab]/i.test(value);
  return false;
}

// Broadcaster and channel tags YouTube uploads carry; the card already says where it is from.
const BROADCASTER_TAGS = /^(?:abc kids|abc iview|abc kids listen|abc tv|cbeebies|cbbc|bbc|bbc earth|bbc kids|netflix(?: jr\.?| kids)?|disney(?: junior| jr\.?)?|nick jr\.?|nickelodeon|pbs kids|milkshake!?|sesame street|official|full episodes?|compilation|kids cartoons?|cartoons? for kids|for kids|hd|4k)$/i;
// Upload padding that says nothing about the episode: "30+ MINS", "TRIPLE", "CBeebies Bedtime Story for Toddlers".
const MARKETING_TAGS = /^(?:(?:\d+\s*\+?\s*(?:mins?|minutes?|hours?|hrs?)(?:\s+of\s+.*)?)|(?:double|triple|quadruple|mega|super)(?:\s+episodes?)?|(?:full\s+)?(?:story\s+|bonus\s+season\s+|season\s+|episode\s+)?compilation|all\s+episodes|(?:abc kids|cbeebies|cbbc|nick jr\.?|pbs kids)\b.*\b(?:story|stories|for (?:toddlers|kids|children)|full episodes?|compilation|songs?)\b.*|(?:learn|songs?|nursery rhymes?)\s+for\s+(?:toddlers|kids|children|babies)|for\s+(?:toddlers|kids|children|babies)|kids\s+(?:songs?|compilation|cartoons?|videos?|tv)|camp youtube|learn to (?:count|read)(?:\s+.*)?|(?:movie\s+)?clips?\s+compilation|baby videos for kids.*|nursery rhymes.*|official animation|(?:music\s*&\s*dance|songs)\s+for\s+kids|.{1,40}\s+official|a colors show|colors)$/i;
const PICTOGRAPH = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
// Words that say nothing about which episode this is. A title part made only of these (and the show's own
// name) is SEO filler ("Baby cartoon & learning videos for kids") and is dropped (Ian, 16 Nov 2026: "just get
// rid of the title if it's not useful").
const FILLER = new Set('a an and the of for with to in on by at from or new best top fun funny cute baby babies kid kids toddler toddlers child children family preschool cartoon cartoons animation animated video videos learning learn educational education nursery rhyme rhymes song songs music dance sing along singalong compilation compilations episode episodes full official hd 4k mins min minutes hour hours long collection clip clips show shows tv channel playlist special'.split(' '));
const meaningful = (part, key) => {
  const skip = new Set(key ? key.split(' ') : []);
  return String(part).toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9']+/).filter(word => word && !FILLER.has(word) && !skip.has(word)).length;
};
const showKey = text => String(text).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/** A title as people would write it: no emoji, no full-width punctuation, no broadcaster tags, no repeat of the show.
 *  "Artist - Song" keeps its dash as " — "; other pieces join with " · ". */
export function tidyTitle(raw, show = '') {
  const key = showKey(show);
  // The card already names the session, so "X performs Y for Mahogany Sessions" is "X — Y"
  // (Ian, 16 Nov 2026: "I would just call this Chet Faker -- Far Side of the Moon").
  const onShow = text => key && (showKey(text).includes(key) || key.includes(showKey(text)) || /\bsessions?\b/i.test(text));
  let text = String(raw || '').normalize('NFKC').replace(PICTOGRAPH, '').replace(/[⧸∕]/g, '/').replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/[｜|]/g, ' · ').replace(/(?:^|\s)[@#][\w.]+/g, ' ')
    .replace(/\(\s*(?:official[^)]*|full episodes?|hd|4k|(?:movie\s+)?clips?(?:\s+compilation)?|compilation)\s*\)/gi, '').replace(/\bfull episodes?\b\s*/gi, '')
    .replace(/\(\s*live\s+(?:on|at|from|for)\s+([^)]*)\)/gi, (all, where) => onShow(where) ? '' : all)
    .replace(/\s+([?!.,:;])/g, '$1').replace(/([?!])\s+(?=[?!])/g, '$1').replace(/\s+/g, ' ').trim();
  const performs = /^(.+?)\s+(?:performs?|plays?|sings?)\s+(.+?)\s+(?:live\s+)?(?:for|at|on|in)\s+(.+)$/i.exec(text);
  if (performs && onShow(performs[3])) text = performs[1] + ' - ' + performs[2];
  // Pieces and the separator before each: " - " between artist and song, " · " otherwise.
  const pieces = [];
  text.split(/\s*·\s*/).forEach(chunk => chunk.split(/\s+[-–—]\s+/).forEach((part, i) => pieces.push({ sep: i ? ' — ' : ' · ', part })));
  const kept = pieces.map(piece => ({ sep: piece.sep, part: piece.part.replace(/^[\s.:,\-–—]+|[\s,:\-–—]+$/g, '').replace(/^["“”'‘’]+(.+?)["“”'‘’]+$/, '$1').trim() })).filter(({ part }) => {
    if (!part || /^[^a-z0-9]+$/i.test(part) || BROADCASTER_TAGS.test(part) || MARKETING_TAGS.test(part)) return false;
    // Short titles that happen to be ordinary words ("Sing", "Full Clip", Bing's "Music") are real titles.
    if (part.split(/\s+/).length >= 3 && !meaningful(part, key)) return false;
    return !key || showKey(part) !== key;
  }).map(piece => {
    // "JoJo & Gran Gran: It's Time to Play" on JoJo and Gran Gran's card is "It's Time to Play";
    // "Post Malone: Tiny Desk Concert" on Tiny Desk's card is "Post Malone".
    const colon = /^([^:]{2,60}):\s*(.+)$/.exec(piece.part);
    if (colon && key && showKey(colon[1]) === key) return { sep: piece.sep, part: colon[2] };
    if (colon && key && onShow(colon[2]) && meaningful(colon[2], key) <= 1) return { sep: piece.sep, part: colon[1] };
    return piece;
  });
  text = kept.map((piece, i) => (i ? piece.sep : '') + piece.part).join('').trim();
  // Nothing but filler: no title at all, the card names the show. Nothing but tags: keep the plainest form.
  if (!text && String(raw || '').split(/\s+/).length >= 3 && !meaningful(String(raw || '').normalize('NFKC'), key)) return '';
  return text || String(raw || '').normalize('NFKC').replace(PICTOGRAPH, '').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/[｜|]/g, ' · ').replace(/\s+/g, ' ').replace(/^[\s·]+|[\s·]+$/g, '').trim();
}

function sameSecret(offered, token) {
  if (!token || typeof offered !== 'string') return false;
  const a = Buffer.from(offered), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True for a Host header naming this Mac by IP, localhost, a .local name or a Tailscale name. */
export function isHomeHost(host) {
  const name = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return isIP(name) > 0 || name === 'localhost' || /^[a-z0-9-]+\.local$/.test(name) || /\.ts\.net$/.test(name)
    || /^[a-z0-9-]+$/.test(name);
}

/** A localStorage stand-in persisted as one JSON file, so player.js learns unchanged. */
export async function createFileStorage(path) {
  let data = Object.create(null);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') data[key] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read TV taste: ${error.message}`); }
  let writes = Promise.resolve();
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem(key, value) { data[key] = String(value); },
    flush() {
      const content = JSON.stringify(data, null, 2) + '\n';
      writes = writes.catch(() => {}).then(() => writeAtomically(path, content));
      return writes;
    },
  };
}

/**
 * The TV's own history with other stores' places laid over it (the Mac app's,
 * read-only): for each file the most recently updated entry wins. Writes go to
 * the TV's own store. `others` returns the current list of stores.
 */
export function layeredHistory(own, others = () => []) {
  return {
    ...own,
    has: path => own.has(path) || others().some(store => store?.has(path)),
    get(path) {
      const entry = this.list().find(item => item.path === path);
      return entry && !entry.completed ? entry.positionSeconds : 0;
    },
    list() {
      const byPath = new Map();
      for (const store of [own, ...others()]) for (const entry of store?.list() || []) {
        const held = byPath.get(entry.path);
        if (!held || Date.parse(entry.updatedAt) > Date.parse(held.updatedAt)) byPath.set(entry.path, entry);
      }
      return [...byPath.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
  };
}

/** Parse a single "bytes=a-b" range against a file size. Returns null for no or unusable range. */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!(start <= end) || start >= size) return { unsatisfiable: true };
  return { start, end };
}

/**
 * The TV-facing model. `videos` comes from readCatalogue; `history` is a
 * loadPlaybackHistory store; `storage` a createFileStorage store.
 */
export function createTvLibrary({ videos, history, storage, random = Math.random, scenes = () => null, showTiers = null, channelScores = null, now = () => Date.now() }) {
  const bySrc = new Map(videos.map((video, index) => [video.src, index]));
  // Per-channel memory of recently played indices, as the player keeps per tab.
  const recent = new Map();
  // Home's "now" pick, so OK plays the episode on the card.
  const staged = new Map();

  function video(src) {
    const index = bySrc.get(src);
    if (index === undefined) throw Object.assign(new Error('That video is not in this library.'), { status: 404 });
    return { index, video: videos[index] };
  }

  function describe(item) {
    const resume = history.get(item.file);
    // The player shows these words: the tidy episode name and the show's name, never the upload's raw title.
    const label = cardShow(item);
    return { src: item.src, title: item.title || item.src, show: item.channel || '', tier: item.tier,
      display: { show: label, episode: isFilm(item) ? '' : episodeLabel(item, label) },
      channels: channelsOf(item), duration: item.duration || 0, resume: resume > 5 ? resume : 0, liked: !!likes()[item.src] };
  }

  // Likes pressed on the TV: { src: { at, key, was } }. A like doubles the episode's weight on the audience's
  // taste key (at least to 2); taking it back restores the weight it had.
  const LIKES_KEY = 'onto.tv.likes';
  function likes() {
    try {
      const parsed = JSON.parse(storage.getItem(LIKES_KEY));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  function liked(src) { return { src: video(src).video.src, liked: !!likes()[src] }; }
  // Everything this audience may watch that has been liked, newest first: the home screen's way back to it.
  function likedList(ids, rating, limit = 30) {
    const held = likes(), out = [];
    for (const [src, like] of Object.entries(held).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))) {
      const index = bySrc.get(src);
      if (index === undefined) continue;
      const channelId = channelsOf(videos[index]).find(id => poolFor(id, ids, rating).includes(index));
      if (!channelId) continue;
      const channel = CHANNEL_BY_ID.get(channelId);
      out.push({ ...describe(videos[index]), channel: { id: channel.id, number: channel.number, name: channel.name } });
      if (out.length >= limit) break;
    }
    return out;
  }
  function like({ src, channel, viewers, liked: want } = {}) {
    const { video: item } = video(src);
    const all = likes(), held = all[item.src];
    const on = typeof want === 'boolean' ? want : !held;
    if (on === !!held) return { src: item.src, liked: on };
    const channelId = TV_CHANNELS.some(entry => entry.id === channel) ? channel : '';
    const key = on ? ((channelId ? channelTasteKey(channelId, viewerIds(viewers)) : tasteKey(viewerIds(viewers))) || channelId || 'grown') : held.key;
    const stored = player.readStored(storage, key);
    const was = player.weightFor(stored, item.src);
    if (on) {
      stored[item.src] = Math.min(4, Math.max(2, was * 2));
      all[item.src] = { at: now(), key, was };
    } else {
      stored[item.src] = Number.isFinite(held.was) && held.was > 0 ? held.was : 1;
      delete all[item.src];
    }
    player.saveWeights(storage, key, stored);
    storage.setItem(LIKES_KEY, JSON.stringify(all));
    player.appendLog(storage, { t: now(), age: key, src: item.src, reason: on ? 'like' : 'unlike', via: 'tv' });
    return { src: item.src, liked: on };
  }

  function viewerIds(value) {
    if (value == null) return TV_VIEWERS.map(person => person.id);
    const parts = Array.isArray(value) ? value : String(value).split(',');
    const known = new Set(TV_VIEWERS.map(person => person.id));
    const ids = [];
    for (const part of parts) {
      const id = String(part).trim().toLowerCase();
      if (known.has(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // The people in the room set the default ceiling (the youngest decides); `rating`
  // overrides it either way. It is a household convenience, not a lock: guests never
  // reach this override, their server passes its own fixed audience.
  function ratingOf(value) {
    const rating = String(value ?? '').trim().toUpperCase();
    return RATING_ORDER.includes(rating) ? rating : null;
  }

  function audience(ids, rating = null) {
    if (!ids.length) return { ceiling: null, blocked: true };
    if (rating) return { ceiling: rating, blocked: false };
    const caps = TV_VIEWERS.filter(person => ids.includes(person.id) && person.ceiling).map(person => person.ceiling);
    if (!caps.length) return { ceiling: 'M', blocked: false };
    const ceiling = caps.reduce((lowest, cap) => (RATING_ORDER.indexOf(cap) < RATING_ORDER.indexOf(lowest) ? cap : lowest));
    return { ceiling, blocked: false };
  }

  function ratingAllowed(item, ceiling, blocked, channelId) {
    if (blocked) return false;
    const channel = TV_CHANNELS.find(entry => entry.id === channelId);
    // Channel ratings override the tier for curated genre channels (e.g. rides items
    // are filed grownup on the Stash but are PG); the regexes are limited to named
    // shows and exclude ad paths, so the override cannot re-badge arbitrary content.
    const rating = channel?.rating || TIER_RATINGS[item.tier] || 'M';
    return RATING_ORDER.indexOf(rating) <= RATING_ORDER.indexOf(ceiling);
  }

  function inGenre(item, channelId) {
    return inTvGenre(item, channelId, channelScores);
  }

  // Which genre channels a video belongs to, before the audience ceiling.
  function channelsOf(item) {
    return TV_CHANNELS.filter(channel => inGenre(item, channel.id)).map(channel => channel.id);
  }

  // A person's own channel shows only when that person is watching without a child.
  function personPresent(channel, ids) {
    if (!channel?.person) return true;
    // A child's own channel shows when that child is the youngest in the room.
    const own = TV_VIEWERS.find(person => person.id === channel.person);
    if (own?.ceiling) return ids.includes(own.id) && !TV_VIEWERS.some(person => person.ceiling && ids.includes(person.id)
      && RATING_ORDER.indexOf(person.ceiling) < RATING_ORDER.indexOf(own.ceiling));
    return ids.includes(channel.person) && !TV_VIEWERS.some(person => person.ceiling && ids.includes(person.id));
  }

  // Kids' things live on the kids' channels. With no child in the audience the kids'
  // channels drop out and shared channels (Christmas, Rides) leave out cartoon tiers.
  // A rating lowered on purpose (G, PG) means children are watching too.
  const grownOnly = (ids, rating) => ids.length > 0 && (!rating || rating === 'M') &&
    !TV_VIEWERS.some(person => person.ceiling && ids.includes(person.id));

  function poolFor(channelId, ids, rating = null) {
    const channel = CHANNEL_BY_ID.get(channelId);
    if (!personPresent(channel, ids)) return [];
    const adults = grownOnly(ids, rating);
    if (adults && channel.audience === 'kid') return [];
    if (!adults && channel.adultsOnly) return [];
    // Ian on his own: Fran's reality and the cosy mysteries stay off his whole tab.
    const ianAlone = ids.length === 1 && ids[0] === 'dad' && adults;
    const { ceiling, blocked } = audience(ids, rating);
    // Christmas episodes wait for December (to 6 January) outside the Christmas channel.
    const date = new Date(now()), festive = date.getMonth() === 11 || (date.getMonth() === 0 && date.getDate() <= 6);
    const seasonal = item => !festive && channelId !== 'christmas' &&
      /\b(?:christmas|xmas|santa|no[eë]l)\b/i.test(String(item.title || '') + ' ' + String(item.src || '').replace(/[._]/g, ' '));
    return videos.map((item, index) => (inGenre(item, channelId) && ratingAllowed(item, ceiling, blocked, channelId) &&
      !(adults && CARTOON_TIERS.has(item.tier)) && !seasonal(item) &&
      !(ianAlone && IAN_SKIPS.test(String(item.channel || '').replace(/^[^\w]+/, ''))) ? index : -1))
      .filter(index => index >= 0);
  }

  // Adults share the Mac player's taste keys. A child in the room does not.
  function tasteKey(ids) {
    const selected = new Set(ids);
    if (!ids.length || TV_VIEWERS.some(person => person.ceiling && selected.has(person.id))) return null;
    const mum = selected.has('mum'), dad = selected.has('dad');
    if (mum && dad) return 'both';
    if (dad) return 'grown';
    if (mum) return Object.prototype.hasOwnProperty.call(player.STREAMS, 'mum') ? 'mum' : 'grown';
    return null;
  }

  function weightsFor(key) {
    if (key !== 'both') return player.readWeights(storage, key, videos);
    const mum = player.readStored(storage, 'mum'), dad = player.readStored(storage, 'dad'), both = player.readStored(storage, 'both');
    const weights = Object.create(null);
    for (const item of videos) {
      weights[item.src] = player.togetherWeight(player.weightFor(mum, item.src), player.weightFor(dad, item.src), player.weightFor(both, item.src));
    }
    return weights;
  }

  function stageKey(channelId, ids, rating = null) {
    return channelId + '\n' + ids.slice().sort().join(',') + '\n' + (rating || '');
  }

  // A person's own channel learns on that person's key: Dad's is the Mac player's "grown".
  function channelTasteKey(channelId, ids) {
    const person = CHANNEL_BY_ID.get(channelId)?.person;
    if (person === 'dad') return 'grown';
    if (person === 'mum') return Object.prototype.hasOwnProperty.call(player.STREAMS, 'mum') ? 'mum' : 'grown';
    return tasteKey(ids);
  }

  const AUDIENCE_ORDER = { grown: { adult: 0, all: 1, kid: 2 }, child: { kid: 0, all: 1, adult: 2 } };

  // Folder names carry a year and "Official" for sorting; the card shows the show's name.
  function showName(name) {
    return String(name).replace(/\s*\((?:19|20)\d\d\)\s*$/, '').replace(/\s*-?\s*Official(?: Channel)?\s*$/i, '').trim() || String(name);
  }

  // What a card says about a pick: the episode in words people use ("S3 E1 · Cactus Hour"),
  // not the file name, and its length in minutes.
  function episodeLabel(item, show) {
    let text = tidyTitle(String(item.title || item.src || '').replace(/\.[a-z0-9]{2,4}$/i, ''), show);
    // Scene-style names ("The.One.where.Monica.Gets...") read as words.
    if ((text.match(/\./g) || []).length >= 3 && (text.match(/ /g) || []).length < 2) text = text.replace(/\.(?!\d)/g, ' ');
    text = text.replace(/[｜|]/g, ' · ').replace(/\(official (?:music )?video\)|\(official audio\)|full episode\s*-?/gi, '')
      .replace(/(?:^|\s)[@#][\w.]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Drop " · <show>" and "<show> -" pieces: the card already names the show.
    text = text.split(' · ').filter(part => part.trim().toLowerCase() !== show.toLowerCase()).join(' · ').trim();
    const series = /(?:series|season)\s*(\d+)\s*(?:ep(?:isode)?\.?|e)\s*(\d+)/i.exec(text) || /\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(text);
    if (!series) text = text.replace(/^(?:series|season)\s*\d+\s+/i, '');
    const words = show.toLowerCase().split(/\s+/).filter(Boolean);
    let rest = text;
    if (series) rest = text.slice(series.index + series[0].length);
    // Only a show name standing alone at the front goes ("Bluey · Bedroom"), not one inside a longer credit
    // ("Paul Woolford, Diplo & Kareen Lomax · Looking for Me", "UGK (Underground Kingz) · ...").
    else if (words.length && text.toLowerCase().startsWith(words.join(' ')) && /^(?:\s*[·:\-–—]|\s+S\d|\s+(?:series|season|ep)\b|$)/i.test(text.slice(words.join(' ').length))) rest = text.slice(words.join(' ').length);
    rest = rest.replace(/^[\s.:·\-–—]+/, '').replace(/\b(?:720p|1080p|2160p|x26[45]|hevc|web-?rip|blu-?ray|brrip|aac|dvdrip)\b.*$/i, '')
      .replace(/^E\d{1,3}\s+/i, '').replace(/[\s.·\-]+$/, '').trim();
    const label = (series ? `S${Number(series[1])} E${Number(series[2])}` : '') + (series && rest ? ' · ' : '') + rest;
    return (label || text).slice(0, 90);
  }

  // A film's card names the film, not its folder ("Family Films").
  function cardShow(item) {
    if (isFilm(item) && FILM_FOLDERS.has(item.channel)) return episodeLabel(item, '').replace(/\s*\(?((?:19|20)\d\d)\)?$/, ' ($1)').trim();
    return showName(item.channel || item.title || item.src);
  }

  function nowPlaying(item, following) {
    const show = cardShow(item);
    const now = { show, title: episodeLabel(item, show), minutes: Math.round((item.duration || 0) / 60), art: '/art?src=' + encodeURIComponent(item.src) };
    if (following) {
      const nextShow = cardShow(following);
      now.next = { show: nextShow, title: isFilm(following) ? '' : episodeLabel(following, nextShow) };
    }
    if (isFilm(item)) now.title = '';
    return now;
  }

  // One line for a later tooltip: the channel, then the shows that fill it.
  function channelAbout(channelId, ids, rating) {
    if (channelId === 'triplej') return 'triple j — on rotation, picked for you';
    if (channelId === 'doublej') return 'Double J — on rotation, picked for you';
    const channel = CHANNEL_BY_ID.get(channelId);
    const counts = new Map();
    for (const index of poolFor(channelId, ids, rating)) {
      const name = showName(videos[index].channel || 'Other');
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
    return top.length ? channel.name + ' — ' + top.map(entry => entry[0]).join(', ') : channel.name;
  }

  function home(viewers, ratingValue) {
    const ids = viewerIds(viewers);
    const selected = new Set(ids);
    const rating = ratingOf(ratingValue);
    const { ceiling, blocked } = audience(ids, rating);
    const people = audience(ids);
    const channels = [];
    for (const channel of TV_CHANNELS) {
      const count = poolFor(channel.id, ids, rating).length;
      if (count) channels.push({ id: channel.id, number: channel.number, name: channel.name, count, about: channelAbout(channel.id, ids, rating) });
    }
    // Grown-ups see their channels first, children theirs; the numbers stay put.
    const order = AUDIENCE_ORDER[ceiling === 'M' ? 'grown' : 'child'];
    const position = new Map(TV_CHANNELS.map((channel, index) => [channel.id, index]));
    // A person's own channel leads their lineup.
    const rank = id => (CHANNEL_BY_ID.get(id).person ? -1 : order[CHANNEL_BY_ID.get(id).audience]);
    // One grown-up alone gets their own running order (PERSON_LINEUP).
    const solo = ids.length === 1 && PERSON_LINEUP[ids[0]] && grownOnly(ids, rating) ? PERSON_LINEUP[ids[0]] : null;
    const placed = id => (solo && solo.includes(id) ? solo.indexOf(id) : (solo ? solo.length : 0));
    // Then an adult audience's learned taste: likes above 1, skips below, over each pool.
    const key = tasteKey(ids);
    const liking = new Map();
    if (key) {
      const weights = weightsFor(key);
      for (const channel of channels) {
        liking.set(channel.id, poolFor(channel.id, ids, rating)
          .reduce((sum, index) => sum + player.weightFor(weights, videos[index].src) - 1, 0));
      }
    }
    const liked = id => liking.get(id) || 0;
    // Before 9am, and for any kids' profile, Cartoons, Little Ones and Bluey lead.
    // Sam, once the morning is over and Jake is not the one watching, leads with Bluey, Hey Duggee and Hop Hop.
    const hour = new Date(now()).getHours();
    const morning = hour < 9 && ceiling !== 'M';
    const samLine = !morning && ceiling !== 'M' && ids.includes('sam') && !ids.includes('jake');
    // Sam's music follows his favourites, ahead of the rest (Ian, 15 Nov 2026: "Sam loves music").
    const samMusic = ids.includes('sam') ? ['kidsongs', 'dance'] : [];
    const lead = samLine ? ['bluey', 'littleones', 'hophop', ...samMusic, 'cartoons'] : (ceiling !== 'M' ? ['cartoons', 'littleones', 'bluey', ...samMusic] : []);
    const leadAt = id => {
      const at = lead.indexOf(id);
      return at < 0 ? lead.length : at;
    };
    const clipAt = id => hour >= 19 && ceiling === 'M' && SHORT_CLIP_CHANNELS.has(id) ? 1 : 0;
    channels.sort((a, b) => clipAt(a.id) - clipAt(b.id) || placed(a.id) - placed(b.id) || rank(a.id) - rank(b.id) || leadAt(a.id) - leadAt(b.id) || liked(b.id) - liked(a.id) ||
      position.get(a.id) - position.get(b.id));
    // Bill each show once: channels with the fewest shows claim theirs first (Seinfeld, Sci-Fi),
    // so a broad channel like For Ian picks around them.
    const billed = new Set();
    const variety = new Map(channels.map(channel => [channel.id,
      new Set(poolFor(channel.id, ids, rating).map(index => videos[index].channel || 'Other')).size]));
    const staging = channels.slice().sort((a, b) => variety.get(a.id) - variety.get(b.id));
    for (const channel of staging) {
      const stage = stageKey(channel.id, ids, rating);
      // The card shows what OK will put on: the episode left on this channel, when there is one.
      const left = leftOn(channel.id, ids, rating);
      if (left !== undefined) staged.set(stage, left);
      // A pick held from before (a tune moves the guide's "next" up) can be a show an earlier card already
      // bills: Cartoons and Little Ones wore one picture on 15 Nov 2026. Stage a fresh one, as a first billing
      // would, when the channel has another show to offer.
      else if (staged.has(stage) && billed.has(videos[staged.get(stage)].channel || 'Other')
        && poolFor(channel.id, ids, rating).some(index => !billed.has(videos[index].channel || 'Other'))) {
        staged.delete(stage); staged.delete(stage + '\nnext');
      }
      if (!staged.has(stage)) staged.set(stage, chooseIndex(channel.id, ids, { rating, billing: true, avoid: billed }));
      billed.add(videos[staged.get(stage)].channel || 'Other');
      // What comes after the card's pick, for the guide and the "now on" panel; it becomes the
      // card's pick once this one is played.
      if (!staged.has(stage + '\nnext') && channel.count > 1) staged.set(stage + '\nnext', chooseIndex(channel.id, ids, { rating, billing: true, current: videos[staged.get(stage)].src, peek: true }));
      const following = staged.has(stage + '\nnext') && staged.get(stage + '\nnext') !== staged.get(stage) ? videos[staged.get(stage + '\nnext')] : null;
      // count: videos on this channel at this audience's ceiling (the morning acceptance gate reads it).
      channel.now = nowPlaying(videos[staged.get(stage)], following);
    }
    // Channels are numbered in the order this audience sees them, so the guide reads 1, 2, 3.
    channels.forEach((channel, index) => { channel.number = index + 1; });
    return {
      ceiling: blocked ? null : ceiling,
      // The ceiling the people alone would set, so the rating switch can show its default.
      defaultCeiling: people.blocked ? null : people.ceiling,
      rating,
      viewers: TV_VIEWERS.map(person => ({ id: person.id, name: person.name, on: selected.has(person.id) })),
      channels,
      liked: likedList(ids, rating),
    };
  }

  function show(name) {
    return videos.filter(item => (item.channel || 'Other') === name).map(describe)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }

  function showOf(index) {
    return videos[index].channel || 'Other';
  }

  // Places and finishes the TV (and the Mac app, via layered history) have reported.
  function watchMaps() {
    const byPath = new Map(videos.map(item => [item.file, item]));
    const places = Object.create(null), finished = new Map();
    for (const entry of history.list()) {
      const item = byPath.get(entry.path);
      if (!item) continue;
      const at = Date.parse(entry.updatedAt) || 0;
      if (entry.completed || player.nearlyFinished(entry.positionSeconds, entry.durationSeconds || item.duration)) finished.set(item.src, at);
      else places[item.src] = { time: entry.positionSeconds, updated: at };
    }
    return { places, finished };
  }

  function finishedRecently(src, finished) {
    const at = finished.get(src);
    return typeof at === 'number' && now() - at < RECENT_FINISH_MS;
  }

  // The episode a household is already in: a half-watched one, or the next one after a finish.
  function continuationIndex(pool, places, finished) {
    let best = -1, bestAt = -Infinity;
    const seen = new Set();
    for (const index of pool) {
      const show = showOf(index);
      if (seen.has(show)) continue;
      seen.add(show);
      let at = -Infinity, active = false, episodic = false;
      for (const candidate of pool) {
        if (showOf(candidate) !== show) continue;
        if (player.episodeNumber(videos[candidate]) === null) continue;
        episodic = true;
        const src = videos[candidate].src;
        const place = places[src];
        if (place && place.time >= 60 && !finished.has(src)) { active = true; at = Math.max(at, place.updated || 0); }
        if (finished.has(src)) { active = true; at = Math.max(at, finished.get(src)); }
      }
      if (!active || !episodic) continue;
      const next = player.seriesNext(videos, pool, show, places, finished, -1);
      if (next >= 0 && at >= bestAt) { best = next; bestAt = at; }
    }
    return best;
  }

  // Don't bill the same show twice inside three picks. Personal channels also keep
  // the current hour to three or more shows when the pool has them.
  function varietyBan(channelId, pool) {
    const shows = new Set(pool.map(showOf));
    if (shows.size < 2) return new Set();
    const played = recent.get(channelId) || [];
    const ban = new Set();
    const span = shows.size >= 3 ? 2 : 1;
    for (const name of played.map(showOf).slice(-span)) ban.add(name);
    if (CHANNEL_BY_ID.get(channelId)?.person && shows.size >= 3) {
      let total = 0;
      const hourShows = new Set();
      for (let i = played.length - 1; i >= 0; i--) {
        const dur = videos[played[i]].duration || 0;
        if (total > 0 && total + dur > 3600) break;
        total += dur;
        hourShows.add(showOf(played[i]));
      }
      if (hourShows.size > 0 && hourShows.size < 3 && total < 3600) for (const name of hourShows) ban.add(name);
    }
    return ban;
  }

  // Where each serial's story is, from the places and finishes the TV has reported.
  function story(show, available, currentIndex, currentFinished) {
    const { places, finished } = watchMaps();
    if (currentFinished && currentIndex >= 0) finished.set(videos[currentIndex].src, now());
    return player.seriesNext(videos, available, show, places, finished, currentIndex);
  }

  // Grade the episode being left (as the player does), then pick the next one.
  function chooseIndex(channelId, ids, options) {
    if (!TV_CHANNELS.some(channel => channel.id === channelId)) {
      throw Object.assign(new Error('Unknown channel.'), { status: 404 });
    }
    let pool = poolFor(channelId, ids, ratingOf(options.rating));
    if (!pool.length) throw Object.assign(new Error('This channel is empty.'), { status: 404 });
    const key = channelTasteKey(channelId, ids) || channelId;
    const played = recent.get(channelId) || [];
    let currentIndex = -1;
    if (typeof options.current === 'string' && options.current) {
      const { index, video: item } = video(options.current);
      currentIndex = index;
      if (options.reason === 'skip' || options.reason === 'ended') {
        const stored = player.readStored(storage, key);
        const was = player.weightFor(stored, item.src);
        const now = player.learnedWeight(was, options.reason, Number(options.time), Number(options.duration) || item.duration, Number(options.watched));
        if (now !== was) { stored[item.src] = now; player.saveWeights(storage, key, stored); }
        player.appendLog(storage, { t: Date.now(), age: key, src: item.src, reason: options.reason, at: Math.round(Number(options.time) || 0),
          watched: Math.round(Number(options.watched) || 0), dur: Math.round(Number(options.duration) || item.duration || 0), via: 'tv' });
      }
    }
    let weights = weightsFor(key);
    const favourites = FAVOURITES[CHANNEL_BY_ID.get(channelId)?.person];
    // Rationed shows are the kids' favourites the parents tire of; grown-ups alone are not rationed.
    const limited = grownOnly(ids, ratingOf(options.rating)) ? [] : pool.filter(index => LIMITED_SHOWS.test(String(videos[index].channel || '') + ' ' + String(videos[index].title || '')));
    // A card's "now on" is a real episode: not a Season 0 special, interview or featurette.
    if (options.billing) {
      const extra = /\bS0+\s?E\d|\bseason 0+\b|\bspecials?\b\/|interview|behind the scenes|featurette|deleted scenes?|bloopers|gag reel|trailer|alternative pilot/i;
      const real = pool.filter(index => !extra.test(String(videos[index].title || '') + ' ' + String(videos[index].src || '')));
      if (real.length) pool = real;
    }
    if (options.billing && limited.length && limited.length < pool.length) {
      const keep = new Set(limited);
      pool = pool.filter(index => !keep.has(index));
    }
    // The home billing shows each show once: a card avoids shows earlier cards took.
    if (options.billing && options.avoid?.size) {
      const fresh = pool.filter(index => !options.avoid.has(videos[index].channel || 'Other'));
      if (fresh.length) pool = fresh;
    }
    const watched = watchMaps();
    // Story still sees a just-finished episode so it can offer the next one. The card does not bill it.
    const storyPool = pool.slice();
    if (options.billing) {
      const open = pool.filter(index => !finishedRecently(videos[index].src, watched.finished));
      if (open.length) pool = open;
    }
    const leaning = !!CHANNEL_BY_ID.get(channelId)?.leaning;
    const scoreItems = CHANNEL_BY_ID.get(channelId)?.scored || leaning ? channelScores?.[channelId]?.items : null;
    if (favourites || limited.length || scoreItems) {
      const learned = weights, rationed = new Set(limited);
      weights = Object.create(null);
      for (const index of pool) {
        const item = videos[index];
        const taste = favourites ? (favourites.test(String(item.channel || '')) ? FAVOURITE_WEIGHT : DISCOVERY_WEIGHT) : 1;
        // Below the learner's floor on purpose: a rationed show stays rare even when loved.
        let weight = rationed.has(index) ? LIMITED_WEIGHT : player.weightFor(learned, item.src) * taste;
        // A leaning channel keeps an unmeasured video at its plain weight; a station's unlisted song is its weakest.
        if (scoreItems && !(leaning && !scoreItems[item.src])) weight = applyScoredChannelWeight(weight, scoreItems[item.src]?.score ?? 0);
        weights[item.src] = weight;
      }
    }
    // Episodic films and sitcoms play in order; cartoons stay shuffled. Personal channels
    // resume a story too, then move on so the hour is not one show.
    const personal = !!CHANNEL_BY_ID.get(channelId)?.person;
    const serial = SERIAL_CHANNELS.has(channelId);
    // peek: what follows the current pick (a serial's next episode), without grading anything.
    const ending = options.reason === 'ended' || options.peek === true;
    const binge = serial && !personal && ending && currentIndex >= 0 && player.episodeNumber(videos[currentIndex]) !== null;
    let index = -1;
    if (binge) index = story(showOf(currentIndex), pool, currentIndex, true);
    const ban = binge ? new Set() : varietyBan(channelId, pool);
    if (!binge && currentIndex >= 0 && (options.peek || personal)) ban.add(showOf(currentIndex));
    if (!binge && ban.size) {
      let fresh = pool.filter(candidate => !ban.has(showOf(candidate)));
      // A rationed show never fills a gap variety opened. Repeat a real show instead.
      if (limited.length) {
        const rationed = new Set(limited);
        const open = fresh.filter(candidate => !rationed.has(candidate));
        fresh = open.length ? open : [];
      }
      if (fresh.length) pool = fresh;
    }
    if (index < 0 && (serial || personal)) {
      const cont = continuationIndex(storyPool, watched.places, watched.finished);
      if (cont >= 0 && pool.includes(cont) && !ban.has(showOf(cont))) index = cont;
    }
    if (index < 0 && channelId === 'forjake') pool.sort((a, b) => jakeLeadRank(videos[a].channel) - jakeLeadRank(videos[b].channel));
    const evening = new Date(now()).getHours() >= 19 && grownOnly(ids, ratingOf(options.rating));
    if (index < 0 && evening) {
      const long = pool.filter(candidate => (videos[candidate].duration || 0) >= LONG_FORM_SECONDS);
      if (long.length) pool = long;
    }
    if (index < 0) {
      index = player.pickVideo(videos, pool, weights, currentIndex, new Set(), played, random, !evening);
      if ((serial || personal) && index >= 0 && player.episodeNumber(videos[index]) !== null) {
        const following = story(showOf(index), pool, currentIndex, binge);
        if (following >= 0 && showOf(following) === showOf(index)) index = following;
      }
    }
    if (index < 0) throw Object.assign(new Error('This channel is empty.'), { status: 404 });
    return index;
  }

  function remember(channelId, index) {
    const played = recent.get(channelId) || [];
    played.push(index);
    recent.set(channelId, played.slice(-RECENT_LIMIT));
    // Kept on disk too: what each channel last put on, so a channel can pick up what was left on it.
    const lasts = lastOn();
    lasts[channelId] = { src: videos[index].src, at: now() };
    storage.setItem(LAST_ON_KEY, JSON.stringify(lasts));
  }

  // A channel remembers what you left (Ian, 14 Nov 2026: one arrow press tuned away from a live set 24 minutes in,
  // and coming back gave a different pick: "never finding that one again"). Coming back to a channel within
  // LEFT_HOURS resumes the episode last on it, if at least LEFT_SECONDS of it had been watched and it is not
  // nearly over. Skipping it or letting it end moves the channel on as before.
  const LAST_ON_KEY = 'onto.tv.lastOn', LEFT_SECONDS = 120, LEFT_HOURS = 12;
  function lastOn() {
    try {
      const parsed = JSON.parse(storage.getItem(LAST_ON_KEY));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  function leftOn(channelId, ids, rating) {
    const last = lastOn()[channelId];
    const index = last && bySrc.get(last.src);
    if (!last || index === undefined) return undefined;
    const place = watchMaps().places[videos[index].src];
    if (!place || place.time < LEFT_SECONDS || now() - place.updated > LEFT_HOURS * 3600000) return undefined;
    if (!poolFor(channelId, ids, rating).includes(index)) return undefined;
    return index;
  }

  function queueFor(channel, show, ids, rating = null) {
    if (!channel?.ads) return [{ kind: 'show', src: show.src, breaks: [] }];
    const { ceiling, blocked } = audience(ids, rating);
    const pool = [];
    for (const item of videos) {
      if (adDecade(item.src) !== channel.ads) continue;
      pool.push({ src: item.src, title: item.title || item.src, duration: item.duration || 0 });
    }
    let blacks = [];
    try {
      const scene = scenes(show.src);
      if (scene && Array.isArray(scene.blacks)) blacks = scene.blacks;
    } catch { blacks = []; }
    let stored = null;
    try { stored = JSON.parse(storage.getItem('onto.ads.played.v1') || ''); }
    catch { stored = null; }
    const built = buildPlayQueue({
      show: { src: show.src, duration: show.duration || 0 },
      ads: pool, blacks, played: stored, now: now(), ceiling, blocked, tiers: showTiers,
    });
    storage.setItem('onto.ads.played.v1', JSON.stringify(built.played));
    return built.queue;
  }

  function finish(index, channelId, ids, rating = null) {
    const described = describe(videos[index]);
    const channel = TV_CHANNELS.find(entry => entry.id === channelId);
    return { ...described, queue: queueFor(channel, described, ids, rating) };
  }

  // Play-next queue (Ian, 6 Nov 2026: "queue timmy time christmas surprise to go on after the current show").
  // A household helper writes ~/.local/state/onto-the-tv/play-next.json = [{ "src": "...", "channel": "christmas"? }];
  // the next request on that channel (or any channel when none is given) plays it, still within the audience rules.
  function takeQueued(channelId, options) {
    const path = join(process.env.HOME || '', '.local/state/onto-the-tv/play-next.json');
    let queue;
    try { queue = JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
    if (!Array.isArray(queue)) return undefined;
    const advancing = options.reason === 'ended' || options.reason === 'skip';
    if (!options.peek && !advancing) return undefined; // tune-ins and guide calls ignore the queue
    const at = queue.findIndex(entry => entry && (!entry.channel || entry.channel === channelId));
    if (at < 0) return undefined;
    const entry = queue[at];
    // Only a real advance uses it up: the episode ended (or was skipped). Peeks and guide/preview calls just show it.
    if (advancing) { queue.splice(at, 1); try { writeFileSync(path, JSON.stringify(queue)); } catch {} }
    const index = bySrc.get(entry.src);
    if (index === undefined || !allowed(entry.src, options.viewers, options.rating)) return undefined;
    return index;
  }

  function next(channelId, options = {}) {
    const ids = viewerIds(options.viewers);
    const rating = ratingOf(options.rating);
    const queued = takeQueued(channelId, options);
    if (queued !== undefined) { remember(channelId, queued); return finish(queued, channelId, ids, rating); }
    const key = stageKey(channelId, ids, rating);
    // Tuning in (not moving on from an episode): the episode left on this channel comes back first.
    if (!options.current) {
      const left = leftOn(channelId, ids, rating);
      if (left !== undefined) staged.set(key, left);
    }
    // A preview may fetch the staged episode without consuming it, so a cancelled
    // press does not change what the channel plays next.
    if (options.prefetch === true) {
      if (!staged.has(key)) return { src: '', title: '', show: '', duration: 0, resume: 0, queue: [], prefetch: true };
      const item = describe(videos[staged.get(key)]);
      item.queue = [{ kind: 'show', src: item.src, breaks: [] }];
      item.prefetch = true;
      return item;
    }
    if (!options.current && staged.has(key)) {
      const index = staged.get(key);
      staged.delete(key);
      // The guide's "next" becomes the card's pick.
      if (staged.has(key + '\nnext')) { staged.set(key, staged.get(key + '\nnext')); staged.delete(key + '\nnext'); }
      remember(channelId, index);
      return finish(index, channelId, ids, rating);
    }
    const index = chooseIndex(channelId, ids, { ...options, rating });
    staged.delete(key);
    remember(channelId, index);
    return finish(index, channelId, ids, rating);
  }

  function progress({ src, positionSeconds, durationSeconds, completed }) {
    const { video: item } = video(src);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0 || typeof completed !== 'boolean') {
      throw Object.assign(new Error('Invalid progress.'), { status: 400 });
    }
    const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : item.duration || 0;
    // Surfing is not watching: start an entry only after half a minute.
    if (!completed && positionSeconds < 30 && !history.has(item.file)) return false;
    history.set(item.file, { title: item.title || item.src, positionSeconds, durationSeconds: duration, completed });
    return true;
  }

  // Whether this audience may watch a video on at least one channel (the guest app checks every file request).
  function allowed(src, viewers, ratingValue) {
    const index = bySrc.get(src);
    if (index === undefined) return false;
    const item = videos[index];
    const { ceiling, blocked } = audience(viewerIds(viewers), ratingOf(ratingValue));
    // Ads belong to no channel; buildPlayQueue already filtered them by this ceiling.
    if (isAdSrc(item.src)) return !blocked;
    return channelsOf(item).some(id => ratingAllowed(item, ceiling, blocked, id));
  }

  // Directions the channel could take from here, one real episode each (Ian, 14 Nov 2026: "if I press down right
  // now I should get some options of different directions the algorithm could go, with tiles, and then we can
  // collect that data to figure out what I like"). Choosing one is not a skip: the show being left is not marked down.
  function directions(channelId, options = {}) {
    const ids = viewerIds(options.viewers), rating = ratingOf(options.rating);
    const current = typeof options.current === 'string' ? bySrc.get(options.current) : undefined;
    const fromIndex = current;
    const offset = Math.max(0, Number(options.offset) || 0);
    let limit = Number(options.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = 12;
    if (limit > 30) limit = 30;
    const exclude = new Set();
    if (Array.isArray(options.exclude)) for (const src of options.exclude) if (typeof src === 'string' && src) exclude.add(src);
    // A show put on by hand (Continue, the Library, a command) plays on no channel: use one it belongs to.
    if (!TV_CHANNELS.some(channel => channel.id === channelId) && current !== undefined) {
      channelId = channelsOf(videos[current]).find(id => poolFor(id, ids, rating).includes(current)) || channelId;
    }
    if (!TV_CHANNELS.some(channel => channel.id === channelId)) throw Object.assign(new Error('Unknown channel.'), { status: 404 });
    const key = channelTasteKey(channelId, ids) || channelId;
    const weights = weightsFor(key);
    const weight = index => player.weightFor(weights, videos[index].src);
    const { places, finished } = watchMaps();
    const begun = index => finished.has(videos[index].src) || !!places[videos[index].src];
    const held = likes();
    const used = new Set(current === undefined ? [] : [current]);
    const usable = index => !used.has(index) && !isAdSrc(videos[index].src);
    const pickTop = (list, score) => {
      const ranked = list.filter(usable).map(index => [score(index), index]).filter(([value]) => value > -Infinity).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      if (!ranked.length) return undefined;
      const chosen = ranked[0][1];
      used.add(chosen);
      return chosen;
    };
    // Ordered episode indices for the endless row; fromIndex is reserved for show-embedding similarity later.
    const rankCandidates = (anchorIndex, pool, score) => pool.filter(index => usable(index))
      .map(index => ({ index, score: score(index) }))
      .filter(entry => Number.isFinite(entry.score) && entry.score > -Infinity)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(entry => entry.index);
    const pool = poolFor(channelId, ids, rating);
    const here = TV_CHANNELS.find(channel => channel.id === channelId);
    const planned = [];
    const plan = (kind, label, index, channel = here) => {
      if (index === undefined) return;
      planned.push({ kind, label, index, channel });
    };
    if (current !== undefined) {
      const show = showOf(current);
      plan('more', show, pickTop(pool.filter(index => showOf(index) === show), index => weight(index) - (finished.has(videos[index].src) ? 2 : 0)));
    }
    plan('new', 'New to you', pickTop(pool.filter(index => !begun(index)), weight));
    plan('favourite', 'Favourite', pickTop(pool, index => (held[videos[index].src] ? 10 : 0) + weight(index) > 1 ? (held[videos[index].src] ? 10 : 0) + weight(index) : -Infinity));
    const long = current !== undefined && (videos[current].duration || 0) >= 1200;
    if (long) plan('short', 'Quick one', pickTop(pool.filter(index => videos[index].duration > 0 && videos[index].duration <= 420), weight));
    else plan('long', 'Long set', pickTop(pool.filter(index => videos[index].duration >= 1800), index => weight(index) + videos[index].duration / 36000));
    // Somewhere else: the other channel whose best unwatched episode this audience rates highest.
    let away = null;
    for (const channel of TV_CHANNELS) {
      if (channel.id === channelId || channel.app) continue;
      const other = poolFor(channel.id, ids, rating).filter(index => usable(index) && !finished.has(videos[index].src));
      if (!other.length) continue;
      const otherKey = channelTasteKey(channel.id, ids) || channel.id;
      const otherWeights = otherKey === key ? weights : weightsFor(otherKey);
      const best = other.reduce((top, index) => (player.weightFor(otherWeights, videos[index].src) > player.weightFor(otherWeights, videos[top].src) ? index : top), other[0]);
      const score = player.weightFor(otherWeights, videos[best].src);
      if (!away || score > away.score) away = { score, index: best, channel };
    }
    if (away) { used.add(away.index); plan('elsewhere', away.channel.name, away.index, away.channel); }
    const taken = directionTally();
    planned.sort((a, b) => (taken[b.kind] || 0) - (taken[a.kind] || 0));
    for (const index of rankCandidates(fromIndex, pool, weight)) {
      if (used.has(index)) continue;
      used.add(index);
      plan('on', showOf(index), index, here);
    }
    for (const channel of TV_CHANNELS) {
      if (channel.id === channelId || channel.app) continue;
      const otherPool = poolFor(channel.id, ids, rating);
      const otherKey = channelTasteKey(channel.id, ids) || channel.id;
      const otherWeights = otherKey === key ? weights : weightsFor(otherKey);
      const otherWeight = index => player.weightFor(otherWeights, videos[index].src);
      for (const index of rankCandidates(fromIndex, otherPool, otherWeight)) {
        if (used.has(index)) continue;
        used.add(index);
        plan('on', channel.name, index, channel);
      }
    }
    const tiles = [];
    for (const entry of planned) {
      const src = videos[entry.index].src;
      if (exclude.has(src)) continue;
      tiles.push({ kind: entry.kind, label: entry.label, ...describe(videos[entry.index]),
        channel: { id: entry.channel.id, number: entry.channel.number, name: entry.channel.name } });
    }
    const page = tiles.slice(offset, offset + limit);
    const nextOffset = offset + page.length < tiles.length ? offset + page.length : null;
    return { channel: channelId, from: current === undefined ? '' : videos[current].src, tiles: page, next: nextOffset };
  }
  const DIRECTION_KEY = 'onto.tv.directionKinds';
  function directionTally() {
    try {
      const parsed = JSON.parse(storage.getItem(DIRECTION_KEY));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  function directionChosen(kind) {
    if (!['more', 'new', 'favourite', 'long', 'short', 'elsewhere'].includes(kind)) return;
    const taken = directionTally();
    taken[kind] = (taken[kind] || 0) + 1;
    storage.setItem(DIRECTION_KEY, JSON.stringify(taken));
  }

  // What each card for this audience shows now, then what each will show next: the pictures worth
  // having ready. Asking stages the picks as the lineup does and moves nothing on.
  function billing(viewers, ratingValue, cards = null) {
    const ids = viewerIds(viewers), rating = ratingOf(ratingValue);
    // A lineup just made for this audience is passed in rather than made again (about 100 ms on the M2).
    const lineup = cards || home(viewers, ratingValue).channels;
    const picks = suffix => lineup.map(channel => staged.get(stageKey(channel.id, ids, rating) + suffix))
      .filter(index => index !== undefined).map(index => videos[index]);
    return [...picks(''), ...picks('\nnext')];
  }

  return { home, billing, show, next, progress, like, liked, directions, directionChosen, allowed, file: src => video(src).video.file, video: src => video(src).video, catalogue: () => videos };
}

/**
 * Have a lineup's pictures ready before its cards need them (a fresh lineup took 2 to 4 s to fill,
 * 15 Nov 2026). One picture at a time, so a viewer's own request is never queued behind these, and
 * one run per audience. Resolves to how many pictures are ready.
 */
export function createArtWarmer({ library, artwork, log = () => {} }) {
  const running = new Set();
  return async function warm(viewers, rating = null, cards = null) {
    if (!artwork || typeof library.billing !== 'function') return 0;
    const key = String(viewers) + '\n' + (rating || '');
    if (running.has(key)) return 0;
    running.add(key);
    let ready = 0;
    try {
      for (const item of library.billing(viewers, rating, cards)) {
        if (await artwork.get(item.file, { durationSeconds: item.duration })) ready += 1;
      }
    } catch (error) { log(`art warm stopped: ${error.message}`); }
    finally { running.delete(key); }
    return ready;
  };
}

async function readBody(request, limit = 16 * 1024) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function send(response, status, body, headers = {}) {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(content);
}

export async function streamFile(request, response, file, mediaCache) {
  let info;
  try { info = await stat(file); }
  catch (error) {
    // The TV player already turns a failed /media response into Retry / next.
    if (error.code === 'ENOENT' || error.code === 'EIO' || error.code === 'ENXIO') {
      throw Object.assign(new Error('This video is offline.'), { status: 404 });
    }
    throw error;
  }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = parseRange(request.headers.range, info.size);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (range?.unsatisfiable) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
    return response.end();
  }
  const { start, end } = range || { start: 0, end: info.size - 1 };
  response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
  if (request.method === 'HEAD') return response.end();
  const stream = mediaCache ? await mediaCache.stream(file, info, { start, end }) : createReadStream(file, { start, end });
  // The client may have gone while the file or cache was opening: then close the stream now.
  if (response.destroyed || request.destroyed) return stream.destroy();
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

/**
 * HTTP front end. `artwork` is optional (createArtworkCache); `uiRoot` holds the TV web UI;
 * `token` is the pairing secret the installed TV app sends.
 */
export function createTvServer({ library, history, storage, artwork, uiRoot, token = '', watchEvents = null, mediaCache = null, diagnostics = createDiagnosticsStore(), gameRelay = createGameRelay(), ukeHandler = createConfiguredUkeHandler({controllerToken:token}), sceneStore = null,
  consoleLauncher = createConsoleLauncher(), libraryRoots = null, catalogueFile = null, playNextFile = null, remoteLog = null, directionsFile = null, log = () => {} }) {
  const allowSrc = src => { try { library.video(src); return true; } catch { return false; } };
  const tvCommands = createTvCommands({ allowSrc });
  const playNext = createPlayNext({ file: playNextFile, allowSrc });
  let nowPlaying = { src: null, position: 0, channel: null, profile: null };
  function librarySrc(src) {
    if (typeof src !== 'string' || src.length < 1 || src.length > 400 || src.includes('..') || src.includes('\\') || src.includes('\0') || src.startsWith('/') || /%2e%2e/i.test(src) || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
    return allowSrc(src) ? src : null;
  }
  function readNow(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    let profile = null;
    if (body.profile != null) {
      if (typeof body.profile !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(body.profile)) return null;
      profile = body.profile;
    }
    let channel = null;
    if (body.channel != null) {
      const channelBody = body.channel;
      if (!channelBody || typeof channelBody !== 'object' || Array.isArray(channelBody)) return null;
      const id = channelBody.id == null ? '' : String(channelBody.id);
      const name = channelBody.name == null ? '' : String(channelBody.name);
      if (id.length > 64 || name.length > 80) return null;
      let number = null;
      if (channelBody.number != null) {
        if (typeof channelBody.number !== 'number' || !Number.isInteger(channelBody.number) || channelBody.number < 0 || channelBody.number > 999) return null;
        number = channelBody.number;
      }
      channel = { id, number, name };
    }
    const position = body.position == null ? 0 : body.position;
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 86400) return null;
    if (body.src == null || body.src === '') return { src: null, position: Math.round(position), channel, profile };
    const src = librarySrc(body.src);
    if (!src) return null;
    return { src, position: Math.round(body.position), channel, profile };
  }
  let dirty = false;
  const save = () => {
    if (!dirty) return Promise.resolve();
    dirty = false;
    return Promise.all([history.flush(), storage.flush(), watchEvents?.flush?.()]).catch(error => { dirty = true; log(`save failed: ${error.message}`); throw error; });
  };
  const timer = setInterval(() => { save().catch(() => {}); }, 15_000);
  timer.unref();

  const warmArt = createArtWarmer({ library, artwork, log });
  const server = createServer(async (request, response) => {
    try {
      if (!isHomeAddress(request.socket.remoteAddress)) return send(response, 403, { error: 'Home network only.' });
      const url = new URL(request.url, 'http://tv.local');
      const path = url.pathname;
      // A Host check blocks DNS rebinding. The page served here is same-origin; the
      // installed TV app is cross-origin and must carry the pairing token. JSON-only
      // POSTs force a preflight, so other pages cannot change taste or history.
      if (!isHomeHost(request.headers.host)) return send(response, 403, { error: 'Use this Mac’s address.' });
      const origin = request.headers.origin;
      // The same host over https is this server behind a TLS proxy that keeps the Host header
      // (tailscale serve): the Mac app's Channels tab loads the page that way.
      if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Onto-Token', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
          return response.end();
        }
        // <video> and <img> cannot send headers, so only /media and /art take the token in the URL.
        const fileToken = path === '/media' || path === '/art' || path === '/subs' || path === '/scene-thumb' || path.startsWith('/uke/audio/');
        const offered = request.headers['x-onto-token'] || (fileToken ? url.searchParams.get('t') : '');
        // The interface's fonts are public files; a stylesheet taken from here by the installed app fetches them cross-origin.
        const openFont = request.method === 'GET' && /^\/fonts\/[A-Za-z0-9._-]+\.woff$/.test(path);
        if (!openFont && !sameSecret(offered, token)) {
          return send(response, 403, { error: 'Pair this TV first.' });
        }
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'POST' && !/^application\/json\b/.test(request.headers['content-type'] || '')) {
        return send(response, 415, { error: 'JSON only.' });
      }
      if (ukeHandler && await ukeHandler(request, response)) return;
      // Diagnostics are deliberately stricter than ordinary same-origin APIs:
      // telemetry can contain playback state and must never be spoofable by a
      // page merely able to reach the home-network address.
      if (path.startsWith('/api/game/')) {
        const result = gameRelay.handle({ method: request.method, path: request.url,
          headers: request.headers, ip: request.socket.remoteAddress,
          body: request.method === 'POST' ? await readBody(request) : undefined,
          tvAuthorized: !!token && sameSecret(request.headers['x-onto-token'], token) });
        response.setHeader('Cache-Control', 'no-store');
        return send(response, result.status, result.body);
      }
      if (path === '/api/console/games' || path === '/api/console/launch') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (path === '/api/console/games') {
          if (request.method !== 'GET') return send(response, 405, { error: 'Method not allowed.' });
          response.setHeader('Cache-Control', 'no-store');
          return send(response, 200, { games: await consoleLauncher.games() });
        }
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const result = await consoleLauncher.launch(await readBody(request));
        return send(response, result.status, result.body);
      }
      if (path === '/api/watch') {
        if (!watchEvents || !token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const result = watchEvents.record(await readBody(request));
        dirty = true;
        await watchEvents.flush();
        return send(response, 200, result);
      }
      if (path === '/api/remote-log') {
        if (!remoteLog || !token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        return send(response, 200, await remoteLog.record(await readBody(request, 32 * 1024)));
      }
      if (path === '/api/play-next') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'GET') return send(response, 200, await playNext.list());
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const body = await readBody(request);
        const src = librarySrc(body.src);
        if (!src) return send(response, 400, { error: 'Invalid source.' });
        const saved = body.consume === true ? await playNext.consume(src) : await playNext.add(src);
        if (!saved) return send(response, 400, { error: 'Invalid source.' });
        return send(response, 200, saved);
      }
      if (path === '/api/now-playing') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'GET') return send(response, 200, nowPlaying);
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const next = readNow(await readBody(request));
        if (!next) return send(response, 400, { error: 'Invalid now playing.' });
        nowPlaying = next;
        return send(response, 200, nowPlaying);
      }
      if (path === '/api/tv-command') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'POST') {
          const result = tvCommands.enqueue(await readBody(request));
          return send(response,result.status,result.body);
        }
        if (request.method === 'GET') {
          const item=tvCommands.get(url.searchParams.get('id'));
          return send(response,item?200:404,item||{error:'Command not found.'});
        }
        return send(response,405,{error:'Method not allowed.'});
      }
      if (path === '/api/diagnostics') {
        const offered = request.headers['x-onto-token'];
        if (!token || !sameSecret(offered, token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (request.method === 'GET') return send(response, 200, diagnostics.snapshot());
        if (request.method === 'POST') {
          const body=await readBody(request), diagnostic=diagnostics.record(body);
          tvCommands.ack(diagnostic.session,body.commandAck);
          return send(response,200,{ok:true,diagnostic,command:tvCommands.next(diagnostic.session)});
        }
        return send(response, 405, { error: 'Method not allowed.' });
      }
      if (path === '/api/scenes') {
        const src = url.searchParams.get('src') || '';
        const file = library.file(src);
        if (!sceneStore) return send(response, 200, { cuts: [], thumbs: [], chapters: false, segments: [], blacks: [] });
        return send(response, 200, sceneStore.api(file, src));
      }
      if (path === '/scene-thumb') {
        const src = url.searchParams.get('src') || '';
        const index = Number(url.searchParams.get('i'));
        const file = library.file(src);
        const thumb = sceneStore ? sceneStore.thumbFile(file, index) : '';
        if (!thumb) return send(response, 404, { error: 'No thumbnail.' });
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return createReadStream(thumb).pipe(response);
      }
      if (path === '/api/subs') {
        const tracks = await listSidecars(library.file(url.searchParams.get('src') || ''));
        return send(response, 200, { tracks });
      }
      if (path === '/subs') {
        const vtt = await readSubtitle(library.file(url.searchParams.get('src') || ''), url.searchParams.get('name') || '');
        response.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(vtt);
      }
      // Proof that this server holds the pairing token, without the token crossing the network: the Mac app
      // checks it before it uses the M2's plain home-network address (the tailnet's HTTPS proves itself).
      if (path === '/api/whoami') {
        const nonce = url.searchParams.get('n') || '';
        if (!token || !/^[0-9a-f]{32,128}$/.test(nonce)) return send(response, 404, { error: 'Not found.' });
        response.setHeader('Cache-Control', 'no-store');
        return send(response, 200, { proof: whoamiProof(token, nonce) });
      }
      if (path === '/api/home') {
        const viewers = url.searchParams.has('viewers') ? url.searchParams.get('viewers') : undefined;
        const lineup = library.home(viewers, url.searchParams.get('rating'));
        send(response, 200, lineup);
        // The cards' pictures start now, ahead of the page asking; the next picks' follow.
        void warmArt(viewers, url.searchParams.get('rating'), lineup.channels);
        return;
      }
      if (path === '/api/library') return send(response, 200, libraryView({ videos: library.catalogue(), history: history.list(), viewers: url.searchParams.has('viewers') ? url.searchParams.get('viewers') : undefined, rating: url.searchParams.get('rating') }));
      if (path === '/api/shows') return send(response, 200, showsView({ videos: library.catalogue(), history: history.list(), viewers: url.searchParams.has('viewers') ? url.searchParams.get('viewers') : undefined, rating: url.searchParams.get('rating') }));
      if (path === '/api/show') return send(response, 200, library.show(url.searchParams.get('name') || ''));
      if (path === '/api/next' && request.method === 'POST') {
        const params = await readBody(request);
        const item = library.next(String(params.channel || ''), params);
        dirty = true;
        return send(response, 200, item);
      }
      if (path === '/api/directions') {
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const params = await readBody(request);
        return send(response, 200, library.directions(String(params.channel || ''), params));
      }
      // What was offered and what was taken (or that the tray was closed): the record the taste work will read.
      if (path === '/api/direction-choice') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const body = await readBody(request, 16 * 1024);
        const text = value => (typeof value === 'string' && value.length <= 400 ? value : '');
        const shown = Array.isArray(body.shown) ? body.shown.slice(0, 8).map(tile => ({ kind: text(tile && tile.kind).slice(0, 24), src: text(tile && tile.src) })) : [];
        if (!shown.length) return send(response, 400, { error: 'Invalid choice.' });
        const entry = { at: new Date().toISOString(), channel: text(body.channel).slice(0, 64), from: text(body.from),
          position: Number.isFinite(body.position) && body.position >= 0 ? Math.round(body.position) : null,
          viewers: text(body.viewers).slice(0, 64), shown, chosen: body.chosen ? { kind: text(body.chosen.kind).slice(0, 24), src: text(body.chosen.src) } : null,
          msOpen: Number.isFinite(body.msOpen) && body.msOpen >= 0 ? Math.min(600000, Math.round(body.msOpen)) : null };
        if (directionsFile) await appendFile(directionsFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
        if (entry.chosen && library.directionChosen) { library.directionChosen(entry.chosen.kind); dirty = true; }
        return send(response, 200, { ok: true });
      }
      if (path === '/api/tv-live') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (request.method !== 'GET') return send(response, 405, { error: 'Method not allowed.' });
        response.setHeader('Cache-Control', 'no-store');
        return send(response, 200, await liveManifest(uiRoot));
      }
      if (path === '/api/like') {
        if (request.method === 'GET') return send(response, 200, library.liked(url.searchParams.get('src') || ''));
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const result = library.like(await readBody(request));
        dirty = true;
        return send(response, 200, result);
      }
      if (path === '/api/progress' && request.method === 'POST') {
        const changed = library.progress(await readBody(request));
        if (changed) dirty = true;
        return send(response, 200, { ok: true });
      }
      if (path === '/media') return await streamFile(request, response, library.file(url.searchParams.get('src') || ''), mediaCache);
      if (path === '/art') {
        const item = library.video(url.searchParams.get('src') || '');
        const file = artwork ? await artwork.get(item.file, { durationSeconds: item.duration }) : null;
        if (!file) return send(response, 404, { error: 'No artwork.' });
        if (response.destroyed || request.destroyed) return;
        const image = createReadStream(file);
        image.on('error', () => response.destroy());
        response.on('close', () => image.destroy());
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return image.pipe(response);
      }
      if (path === '/api/media-cache') {
        if (!sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        return send(response, 200, mediaCache?.stats() || { enabled: false });
      }
      if (path === '/api/health') {
        if (libraryRoots == null) return send(response, 200, { ok: true });
        // The TV finds the server by this answer within 2.5 s. A library disk that hangs (16 Nov 2026: a stat on the
        // Stash drive never returned behind an unanswered macOS prompt) must not hide a server that is up.
        const report = (async () => {
          const roots = typeof libraryRoots === 'function' ? await libraryRoots() : libraryRoots;
          return libraryHealthReport(await catalogueStatus(roots, catalogueFile));
        })();
        const library = await Promise.race([report, new Promise(resolve => setTimeout(() => resolve({ status: 'slow' }), 1500))]);
        return send(response, 200, { ok: true, library });
      }
      // Static TV UI. A trailing slash is that folder's index, so /games/ is the games page.
      let name = path === '/' ? '/index.html' : path;
      if (name.endsWith('/')) name += 'index.html';
      const file = normalize(join(uiRoot, name));
      if (!file.startsWith(uiRoot + '/') || !STATIC[extname(file)]) return send(response, 404, { error: 'Not found.' });
      const content = await readFile(file).catch(() => null);
      if (!content) return send(response, 404, { error: 'Not found.' });
      response.writeHead(200, { 'Content-Type': STATIC[extname(file)], 'Cache-Control': 'no-cache' });
      return response.end(content);
    } catch (error) {
      if (!response.headersSent) send(response, error.status || 500, { error: error.message });
      else response.destroy();
      // Path only: the query can carry the pairing token.
      if (!error.status) log(`error ${request.method} ${String(request.url).split('?')[0]}: ${error.stack || error.message}`);
    }
  });
  const close = server.close.bind(server);
  server.close = callback => { clearInterval(timer); dirty = true; save().catch(() => {}).finally(() => close(callback)); return server; };
  // The start-up and reload warm (bin/tv-server.js) uses the same one-at-a-time queue.
  server.warmArt = warmArt;
  return server;
}

/** Load the generated catalogue (the shuffler HTML) as player.js videos with absolute files. */
export async function loadCatalogue(playerPath, outputPath = playerPath) {
  return readCatalogue(await readFile(playerPath, 'utf8'), playerPath, outputPath);
}
