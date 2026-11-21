#!/opt/homebrew/bin/python3
"""Which is the smallest local model that drives the TV reliably?

Runs household requests through Fred's tool set (src/fred-mcp.js) on local Ollama models and scores the
first tool call: the right tool, and the argument carrying the right words. Pick the smallest model that
clears ~95%. Usage: bench.py MODEL [MODEL...]   (results also appended to results.jsonl beside this file)
"""
import json, subprocess, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYSTEM = ("You control the family TV for a young child named Jake. Use exactly one tool for each request. "
          "Use play_video to play something specific, find_videos only when asked what there is, "
          "change_channel for channels, pause/resume/go_home for controls, whats_on when asked what's playing.")


_TOOLS = None


def tools():
    global _TOOLS
    if _TOOLS is None:  # Fred's own definitions, so the bench tests the real interface
        out = subprocess.run(['node', '--input-type=module', '-e',
                              "import { TOOLS } from './src/fred-mcp.js'; console.log(JSON.stringify(TOOLS))"],
                             cwd=HERE.parent.parent, capture_output=True, text=True, check=True).stdout
        _TOOLS = [{'type': 'function', 'function': {'name': t['name'], 'description': t['description'], 'parameters': t['inputSchema']}}
                  for t in json.loads(out)]
    return _TOOLS


# v2: a surface a small model can't get wrong. The server decides channel vs video vs "number 3".
TOOLS_V2 = [
    {'type': 'function', 'function': {'name': 'play', 'description': 'Play anything on the TV: a show, a video, a channel, or "number 3" from the last list. Use for any request to watch or put something on.',
                                      'parameters': {'type': 'object', 'properties': {'what': {'type': 'string', 'description': 'What to play, in the words the person used.'}}, 'required': ['what']}}},
    {'type': 'function', 'function': {'name': 'control', 'description': 'Pause, resume, go home (stop or turn off), louder or quieter.',
                                      'parameters': {'type': 'object', 'properties': {'action': {'type': 'string', 'enum': ['pause', 'resume', 'home', 'louder', 'quieter']}}, 'required': ['action']}}},
    {'type': 'function', 'function': {'name': 'whats_on', 'description': 'Say what is playing on the TV right now.', 'parameters': {'type': 'object', 'properties': {}}}},
    {'type': 'function', 'function': {'name': 'list', 'description': 'Only when the person asks what there is: list the channels, or videos about something.',
                                      'parameters': {'type': 'object', 'properties': {'about': {'type': 'string', 'description': 'Topic, or empty for the channel list.'}}}}},
]
V2 = {'play_video': ('play', 'what'), 'change_channel': ('play', 'what'), 'find_videos': ('list', 'about'), 'list_channels': ('list', None),
      'pause': ('control', 'pause'), 'resume': ('control', 'resume'), 'go_home': ('control', 'home'), 'whats_on': ('whats_on', None)}
SYSTEM_V2 = "You control the family TV for a young child named Jake. Call exactly one tool for each request. /no_think"
USE_V2 = '--v2' in sys.argv
USE_V3 = '--v3' in sys.argv  # no tool calling: output forced into one JSON shape, with worked examples
V3_SCHEMA = {'type': 'object', 'properties': {'action': {'type': 'string', 'enum': ['play', 'pause', 'resume', 'home', 'whats_on', 'list', 'louder', 'quieter']},
                                              'what': {'type': 'string'}}, 'required': ['action', 'what']}
V3_SYSTEM = ('You turn what a child or parent says into one TV action as JSON {"action","what"}. Actions: play (watch or put on '
             'anything: a show, a channel, a video, "number 2"), pause, resume, home (stop, turn off, go back), whats_on (what is '
             'playing), list (what is there / what can I watch), louder, quieter. "what" is the thing in their words, or "".\n'
             'Examples:\n"stick on octonauts" -> {"action":"play","what":"octonauts"}\n"the lego channel" -> {"action":"play","what":"lego channel"}\n'
             '"wait a minute" -> {"action":"pause","what":""}\n"ok carry on" -> {"action":"resume","what":""}\n"we are done for today" -> {"action":"home","what":""}\n'
             '"is there anything with sharks" -> {"action":"list","what":"sharks"}\n"who is this" -> {"action":"whats_on","what":""}\n"too loud" -> {"action":"quieter","what":""}')
V3 = {'play_video': 'play', 'change_channel': 'play', 'find_videos': 'list', 'list_channels': 'list', 'pause': 'pause', 'resume': 'resume', 'go_home': 'home', 'whats_on': 'whats_on'}


# (request, tool, words that must appear in the argument; [] = no argument check)
CASES = [
    ("put on bluey", "play_video", ["bluey"]), ("play some hot wheels videos", "play_video", ["hot wheels"]),
    ("can you play the bluey christmas episode", "play_video", ["bluey", "christmas"]),
    ("I want to watch minecraft", "play_video", ["minecraft"]), ("play paw patrol please", "play_video", ["paw patrol"]),
    ("the one with the dog at christmas", "play_video", ["dog"]), ("trains!", "change_channel", ["train"]),
    ("go to the christmas channel", "change_channel", ["christmas"]), ("channel 5", "change_channel", ["5"]),
    ("switch to the cars channel", "change_channel", ["car"]), ("put the fireplace on", "change_channel", ["fireplace"]),
    ("what channels are there", "list_channels", []), ("what can I watch", "list_channels", []),
    ("pause it", "pause", []), ("stop for a sec", "pause", []), ("hang on, I need the toilet", "pause", []),
    ("keep going", "resume", []), ("play again", "resume", []), ("unpause", "resume", []),
    ("go back to the start screen", "go_home", []), ("turn it off", "go_home", []), ("home", "go_home", []),
    ("what's on", "whats_on", []), ("what is this show called", "whats_on", []), ("what are we watching", "whats_on", []),
    ("are there any dinosaur videos", "find_videos", ["dinosaur"]), ("find me something about space", "find_videos", ["space"]),
    ("do we have any lego videos", "find_videos", ["lego"]), ("show me the list of monster truck ones", "find_videos", ["monster truck"]),
    ("play number 3", "play_video", []), ("something christmassy", "change_channel", ["christmas"]),
    ("I'm bored, play something with diggers", "play_video", ["digger"]), ("put on the snowman movie", "play_video", ["snowman"]),
    ("can we watch peppa pig", "play_video", ["peppa"]), ("stop the video", "pause", []),
]


def chat3(model, text):
    body = {'model': model, 'stream': False, 'format': V3_SCHEMA, 'think': False, 'options': {'temperature': 0},
            'messages': [{'role': 'system', 'content': V3_SYSTEM}, {'role': 'user', 'content': text}]}
    req = urllib.request.Request('http://127.0.0.1:11434/api/chat', json.dumps(body).encode(), {'content-type': 'application/json'})
    t = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        d = json.loads(r.read())
    try:
        j = json.loads(d['message']['content'])
        return {'name': j.get('action'), 'arguments': {'what': j.get('what', '')}}, time.time() - t
    except (ValueError, KeyError):
        return None, time.time() - t


def chat(model, text):
    if USE_V3:
        return chat3(model, text)
    body = {'model': model, 'stream': False, 'messages': [{'role': 'system', 'content': SYSTEM_V2 if USE_V2 else SYSTEM}, {'role': 'user', 'content': text}],
            'tools': TOOLS_V2 if USE_V2 else tools(), 'options': {'temperature': 0}, 'think': False}
    req = urllib.request.Request('http://127.0.0.1:11434/api/chat', json.dumps(body).encode(), {'content-type': 'application/json'})
    t = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        d = json.loads(r.read())
    calls = d.get('message', {}).get('tool_calls') or []
    return calls[0]['function'] if calls else None, time.time() - t


def score(model):
    ok, rows, lat = 0, [], []
    for text, want, words in CASES:
        try:
            got, dt = chat(model, text)
        except Exception as e:
            got, dt = {'error': str(e)[:80]}, 0
        args = json.dumps((got or {}).get('arguments', {})).lower()
        if USE_V3:
            good = bool(got) and got.get('name') == V3[want] and all(w in args for w in words)
        elif USE_V2:
            name, key = V2[want]
            if name == 'control':
                good = bool(got) and got.get('name') == 'control' and key in args
            else:
                good = bool(got) and got.get('name') == name and all(w in args for w in words)
        else:
            good = bool(got) and got.get('name') == want and all(w in args for w in words)
        ok += good; lat.append(dt)
        rows.append({'text': text, 'want': want, 'got': got, 'ok': good})
    res = {'model': model, 'tools': 'v3' if USE_V3 else 'v2' if USE_V2 else 'fred', 'score': round(ok / len(CASES), 3), 'n': len(CASES), 'median_s': round(sorted(lat)[len(lat) // 2], 2),
           'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'misses': [r for r in rows if not r['ok']]}
    with open(HERE / 'results.jsonl', 'a') as f:
        f.write(json.dumps(res) + '\n')
    print(f"{model:32s} {res['score']*100:5.1f}%  median {res['median_s']}s  misses {len(res['misses'])}")
    return res


if __name__ == '__main__':
    assert len(tools()) == 8, f'parsed {len(tools())} tools from fred-mcp.js'
    for m in [a for a in sys.argv[1:] if not a.startswith('--')]:
        score(m)
