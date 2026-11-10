"""Builds docs/demo.gif from the frames record.ts saved in dist/demo: a browser window around each
frame, the scene's caption underneath, slow stretches sped up as record.ts marked them, and one
palette for every frame. Needs Pillow, and macOS for its system font."""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]
WORK = REPO / 'dist' / 'demo'
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / 'docs' / 'demo.gif'
WIDTH = 1000
BAR = 34
BAND = 48
MIN_MS = 100
MAX_MS = 2500
END_HOLD_MS = 3500

# Changing one only needs this script run again, not a new recording.
CAPTIONS = {
    'create': 'Every workspace gets a branch, a checkout and a Linux VM of its own',
    'ask': 'Tell the Lead what you want done',
    'spawn': 'The Lead brings in agents on other models, each in a tab of its own',
    'build': 'Claude builds it with permission prompts off: the VM is the boundary',
    'review': 'The Lead reads the report, and has Codex review the work',
    'fix': 'It sends the review back to Build, and tells you when it’s done',
    'terminal': 'Inside the VM, credentials are only placeholders',
    'proxy': 'Docker Sandboxes’ proxy swaps in the real ones on the way out',
    'changes': 'Then read the diff, and open a pull request',
}
# Scenes with a picture laid over the page.
OVERLAYS = {'proxy': WORK / 'overlay-proxy.png'}

timeline = json.loads((WORK / 'timeline.json').read_text())
frames = timeline['frames']
view = timeline['view']
content_height = round(view['height'] * WIDTH / view['width'])
height = BAR + content_height + BAND


def font(size, weight=400):
    face = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', size)
    # Its first axis is width, so each axis is set by name.
    axes = {axis['name']: axis['default'] for axis in face.get_variation_axes()}
    axes[b'Weight'] = weight
    axes[b'Optical Size'] = max(17, min(96, size))
    face.set_variation_by_axes(list(axes.values()))
    return face


URL_FONT = font(13)
CAPTION_FONT = font(19, 590)
BUTTONS = ['#ff5f57', '#febc2e', '#28c840']


def window():
    canvas = Image.new('RGB', (WIDTH, height), '#000000')
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, WIDTH, BAR - 1], fill='#2b2b2f')
    draw.line([0, BAR - 1, WIDTH, BAR - 1], fill='#3c3c41')
    for index, colour in enumerate(BUTTONS):
        x = 18 + index * 20
        draw.ellipse([x - 6, BAR / 2 - 6, x + 6, BAR / 2 + 6], fill=colour)
    draw.rounded_rectangle((WIDTH / 2 - 190, 6, WIDTH / 2 + 190, BAR - 7), radius=7, fill='#1c1c1f', outline='#45454b')
    draw.text((WIDTH / 2, BAR / 2), 'localhost:4700', fill='#c7c7cc', font=URL_FONT, anchor='mm')
    draw.rectangle([0, BAR + content_height, WIDTH, height], fill='#17213a')
    draw.line([0, BAR + content_height, WIDTH, BAR + content_height], fill='#2c3a5c')
    return canvas


BASE = window()
overlays = {scene: Image.open(file).convert('RGBA') for scene, file in OVERLAYS.items() if file.exists()}


def compose(frame):
    shot = Image.open(WORK / 'frames' / frame['file']).convert('RGBA')
    if frame['scene'] in overlays:
        shot = Image.alpha_composite(shot, overlays[frame['scene']].resize(shot.size))
    canvas = BASE.copy()
    canvas.paste(shot.convert('RGB').resize((WIDTH, content_height), Image.LANCZOS), (0, BAR))
    caption = CAPTIONS.get(frame['scene'])
    if caption:
        ImageDraw.Draw(canvas).text((WIDTH / 2, BAR + content_height + BAND / 2), caption, fill='#f9fafb', font=CAPTION_FONT, anchor='mm')
    return canvas


# Each frame shows for its real time divided by its scene's speed, and identical frames are merged.
shown, last = [], None
for index, frame in enumerate(frames):
    following = frames[index + 1]['t'] if index + 1 < len(frames) else frame['t'] + END_HOLD_MS
    duration = (following - frame['t']) / frame['speed']
    image = compose(frame)
    digest = hashlib.sha1(image.tobytes()).hexdigest()
    if digest == last:
        shown[-1][1] += duration
        continue
    shown.append([image, duration, frame['scene']])
    last = digest

# A frame too brief to see is replaced by the next, so the GIF never asks for less than MIN_MS,
# which browsers would stretch to a tenth of a second.
kept = []
for image, duration, scene in shown:
    if kept and kept[-1][1] < MIN_MS:
        kept[-1] = [image, kept[-1][1] + duration, scene]
    else:
        kept.append([image, duration, scene])
durations = [int(min(max(duration, MIN_MS), MAX_MS) // 10 * 10) for _, duration, _ in kept[:-1]] + [END_HOLD_MS]

# One palette for every frame, from a sample of them, without dithering, so text stays sharp. The
# window's buttons are too small to keep their colours that way, so they get a swatch of their own.
sample = [image for image, _, _ in kept[::max(1, len(kept) // 24)]]
sheet = Image.new('RGB', (WIDTH, height * len(sample) + 120))
for index, image in enumerate(sample):
    sheet.paste(image, (0, height * index))
for index, colour in enumerate(BUTTONS):
    sheet.paste(Image.new('RGB', (WIDTH // len(BUTTONS), 120), colour), (index * WIDTH // len(BUTTONS), height * len(sample)))
palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
indexed = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image, _, _ in kept]
indexed[0].save(OUT, save_all=True, append_images=indexed[1:], duration=durations, loop=0, optimize=False, disposal=1)

# The last frame of each scene, to look at without playing the GIF.
previews = WORK / 'previews'
previews.mkdir(exist_ok=True)
per_scene = {}
for (image, _, scene), duration in zip(kept, durations):
    per_scene[scene] = per_scene.get(scene, 0) + duration
    image.save(previews / f'{scene}.png')
print(f'{OUT}: {len(kept)} frames, {sum(durations) / 1000:.1f} s, {OUT.stat().st_size / 1e6:.2f} MB, {WIDTH}x{height}')
print('  '.join(f'{scene} {ms / 1000:.1f}s' for scene, ms in per_scene.items()))
