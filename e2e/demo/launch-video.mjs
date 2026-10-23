// Renders the square launch video for X and LinkedIn from a clean recording made with
//   DEMO_SCALE=2 DEMO_CLEAN=1 node e2e/demo/record.mjs <dir>
// Run: node e2e/demo/launch-video.mjs <dir> [voice.(aiff|wav|mp3)] [music.(wav|mp3)]
// Without a voice file it speaks the script with macOS `say`; without music it synthesizes a bed.
// Replace either by passing a file: the timing comes from SCENES below.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const dir = resolve(process.argv[2] ?? '.');
const marks = JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8'));
const out = join(dir, 'launch');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const S = 1080;
const FPS = 30;
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);

// The script. `card` scenes are animated text; `clip` scenes are UI moments from the recording
// (times on that person's timeline, in seconds after the demo started). `say` is the voiceover.
const SCENES = [
  { card: 'hook', d: 2.6, say: 'Your whole team codes with AI agents.' },
  { card: 'alone', d: 2.6, say: 'But every agent works alone.' },
  { card: 'logo', d: 3.0, say: 'Pearcoder puts them in one session.' },
  {
    clip: 'hana',
    from: marks.taskCreated - 2.3,
    to: marks.taskCreated + 0.5,
    area: 'bottom',
    caption: "Ask a teammate's agent for a fix",
    say: "Ask a teammate's agent for a fix.",
  },
  {
    clip: 'hana',
    from: marks.taskCreated + 0.6,
    to: marks.taskCreated + 2.6,
    area: 'top',
    caption: 'It waits for its owner',
    say: 'It waits for its owner.',
  },
  {
    clip: 'alice',
    from: marks.editStart - 4.6,
    to: marks.approved + 0.6,
    area: 'top',
    caption: 'Its owner approves, or rewrites it',
    say: 'Its owner approves it. Or rewrites it first.',
  },
  {
    clip: 'hana',
    from: marks.agentStart,
    to: marks.agentEnd + 0.3,
    speed: 3,
    area: 'top',
    caption: 'Their own agent does the work',
    say: 'Then their own Claude Code does the work.',
  },
  {
    clip: 'hana',
    from: marks.agentEnd + 0.3,
    to: marks.agentEnd + 4.3,
    area: 'top',
    caption: 'It ships a branch. Never main.',
    say: 'It ships a branch. Never main.',
  },
  { card: 'git', d: 3.0, say: 'Code moves through git. Never through Pearcoder.' },
  { card: 'nobody', d: 2.8, say: "And nobody runs anyone else's agent." },
  { card: 'cta', d: 3.8, say: 'Pearcoder. Where agents and humans have a tea party.' },
];

const CARDS = {
  hook: `<h1 class="big">Your team has<br><span class="pear">AI agents.</span></h1>`,
  alone: `<h1 class="big">Every one<br>works <span class="strike">alone</span>.</h1>`,
  logo: `<img class="logo" src="LOGO"><h1 class="mid">Pearcoder</h1><p class="sub">One session for your team<br>and everyone's own agent.</p>`,
  git: `<h1 class="mid">Code moves<br>through <span class="pear">git</span>.</h1><p class="sub">Never through Pearcoder.</p>`,
  nobody: `<h1 class="mid">Nobody runs<br>anyone else's<br><span class="pear">agent.</span></h1>`,
  cta: `<img class="logo small" src="LOGO"><h1 class="mid mono">npx pearcoder</h1><p class="sub">github.com/pearcoderhq/pearcoder</p><p class="tag">Where agents and humans have a tea party.</p>`,
};
const logo = `data:image/png;base64,${readFileSync(resolve(import.meta.dirname, '../../assets/brand/pearcoder_logo.png')).toString('base64')}`;
const STYLE = `
  html,body{margin:0;width:${S}px;height:${S}px;overflow:hidden}
  body{font-family:-apple-system,"SF Pro Display","Inter",system-ui,sans-serif;color:#fff;
    background:radial-gradient(120% 120% at 20% 10%,#1d3a2a 0%,#0f1b2d 55%,#0a1220 100%)}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:28px}
  .big{font-size:112px;line-height:1.02;letter-spacing:-3px;margin:0;font-weight:800}
  .mid{font-size:92px;line-height:1.04;letter-spacing:-2.5px;margin:0;font-weight:800}
  .mono{font-family:"SF Mono",Menlo,monospace;letter-spacing:-1px;font-size:82px}
  .sub{font-size:40px;color:#b9cbd8;margin:0;line-height:1.3}
  .tag{font-size:34px;color:#8fd19e;margin:18px 0 0;font-style:italic}
  .pear{color:#8fd19e}
  .logo{width:220px;height:220px;border-radius:44px}
  .logo.small{width:150px;height:150px;border-radius:30px}
  .strike{position:relative;color:#ff9b8a}
  .strike::after{content:"";position:absolute;left:-4%;right:-4%;top:55%;height:12px;background:#ff9b8a;border-radius:6px;
    transform-origin:left;animation:strike .5s .9s both cubic-bezier(.2,.8,.2,1)}
  .wrap>*{animation:rise .7s both cubic-bezier(.2,.8,.2,1)}
  .wrap>*:nth-child(2){animation-delay:.12s}.wrap>*:nth-child(3){animation-delay:.24s}.wrap>*:nth-child(4){animation-delay:.36s}
  @keyframes rise{from{opacity:0;transform:translateY(60px) scale(.96)}to{opacity:1;transform:none}}
  @keyframes strike{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .frame{position:absolute;left:40px;top:360px;width:1000px;height:520px;border-radius:28px;
    box-shadow:0 0 0 2000px #0f1b2d, 0 0 0 2006px rgba(143,209,158,.35)}
  .mark{position:absolute;left:0;right:0;bottom:90px;text-align:center;font-size:30px;color:#8fd19e;font-weight:700;letter-spacing:1px}
  .cap{position:absolute;left:60px;right:60px;top:170px;height:150px;display:flex;align-items:center;justify-content:center;
    text-align:center;font-size:62px;line-height:1.08;font-weight:800;letter-spacing:-1.5px;
    animation:rise .5s both cubic-bezier(.2,.8,.2,1)}
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: S, height: S } });
const frame = (html) =>
  page.setContent(`<!doctype html><style>${STYLE}</style>${html}`, { waitUntil: 'load' });
// Seek every CSS animation to `t` seconds, so frames come out the same on any machine.
const seek = (t) =>
  page.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = ms;
    }
  }, t * 1000);

const parts = [];
for (const [i, scene] of SCENES.entries()) {
  const file = join(out, `part-${i}.mp4`);
  if (scene.card) {
    const frames = join(out, `card-${i}`);
    mkdirSync(frames);
    await frame(`<div class="wrap">${CARDS[scene.card].replaceAll('LOGO', logo)}</div>`);
    const n = Math.round(scene.d * FPS);
    for (let f = 0; f < n; f++) {
      await seek(f / FPS);
      await page.screenshot({ path: join(frames, `${String(f).padStart(4, '0')}.png`) });
    }
    ff(
      '-framerate',
      String(FPS),
      '-i',
      join(frames, '%04d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '16',
      file,
    );
  } else {
    // The caption and a rounded window: an overlay with a transparent hole over the clip.
    const overlay = join(out, `overlay-${i}.png`);
    await frame(
      `<div class="frame"></div><div class="cap">${scene.caption}</div><div class="mark">pearcoder</div>`,
    );
    await page.evaluate(() => {
      document.body.style.background = 'transparent';
    });
    await seek(0.6);
    await page.screenshot({ path: overlay, omitBackground: true });
    const source = marks[scene.clip];
    // The recording's main pane at 2x, tight around the task card (top) or the task form (bottom),
    // so the UI text stays readable on a phone.
    const crop = scene.area === 'bottom' ? 'crop=1340:697:540:640' : 'crop=1300:676:570:370';
    const speed = scene.speed ?? 1;
    const d = (scene.to - scene.from) / speed;
    scene.d = d;
    ff(
      '-ss',
      String(source.start + scene.from),
      '-t',
      String(scene.to - scene.from),
      '-i',
      source.file,
      '-loop',
      '1',
      '-i',
      overlay,
      '-filter_complex',
      `[0:v]setpts=(PTS-STARTPTS)/${speed},${crop},scale=1000:520:flags=lanczos,pad=${S}:${S}:40:360:color=0x0f1b2d,fps=${FPS}[v];[v][1:v]overlay=0:0:shortest=1,format=yuv420p[o]`,
      '-map',
      '[o]',
      '-t',
      String(d),
      '-c:v',
      'libx264',
      '-crf',
      '16',
      file,
    );
  }
  parts.push({ file, d: scene.d });
}
await browser.close();

// Picture: hard cuts on the beat, with a short fade at the very start and end.
const total = parts.reduce((sum, p) => sum + p.d, 0);
const list = join(out, 'parts.txt');
writeFileSync(list, parts.map((p) => `file '${p.file}'`).join('\n'));
const picture = join(out, 'picture.mp4');
ff(
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  list,
  '-vf',
  `fade=in:0:12,fade=out:st=${total - 0.6}:d=0.6`,
  '-c:v',
  'libx264',
  '-crf',
  '17',
  '-pix_fmt',
  'yuv420p',
  picture,
);

// Voice: one clip per scene, starting 0.15 s into it.
const voiceArg = process.argv[3];
const voice = join(out, 'voice.wav');
if (voiceArg) {
  ff('-i', resolve(voiceArg), '-ar', '48000', '-ac', '2', voice);
} else {
  const inputs = [];
  const delays = [];
  let at = 0;
  for (const [i, scene] of SCENES.entries()) {
    const line = join(out, `vo-${i}.aiff`);
    execFileSync('say', [
      '-v',
      process.env.DEMO_VOICE ?? 'Samantha',
      '-r',
      '178',
      '-o',
      line,
      scene.say,
    ]);
    inputs.push('-i', line);
    const ms = Math.round((at + 0.15) * 1000);
    delays.push(`[${i}:a]aresample=48000,adelay=${ms}|${ms},apad[a${i}]`);
    at += scene.d;
  }
  ff(
    ...inputs,
    '-filter_complex',
    `${delays.join(';')};${SCENES.map((_, i) => `[a${i}]`).join('')}amix=inputs=${SCENES.length}:normalize=0,atrim=0:${total},pan=stereo|c0=c0|c1=c0[v]`,
    '-map',
    '[v]',
    '-ar',
    '48000',
    voice,
  );
}

// Music: the given track, or a synthesized bed: a four-on-the-floor kick at 120 bpm, off-beat
// hats and a soft A-minor pad that swells. Ducked under the voice.
const musicArg = process.argv[4];
const music = join(out, 'music.wav');
if (musicArg) {
  ff('-i', resolve(musicArg), '-t', String(total), '-ar', '48000', '-ac', '2', music);
} else {
  const beat = 0.5;
  const kick = `0.9*sin(2*PI*(45+80*exp(-mod(t,${beat})*30))*mod(t,${beat}))*exp(-mod(t,${beat})*9)`;
  const hat = `0.12*(random(0)*2-1)*exp(-mod(t+${beat / 2},${beat})*60)`;
  const pad = `0.10*(sin(2*PI*220*t)+sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+0.6*sin(2*PI*110*t))*(0.6+0.4*sin(2*PI*t/8))`;
  ff(
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${kick}+${hat}+${pad}':s=48000:d=${total}`,
    '-af',
    `lowpass=f=9000,afade=in:st=0:d=0.8,afade=out:st=${total - 1.2}:d=1.2,volume=0.55`,
    '-ac',
    '2',
    music,
  );
}

const final = join(out, 'pearcoder-launch.mp4');
ff(
  '-i',
  picture,
  '-i',
  voice,
  '-i',
  music,
  '-filter_complex',
  '[2:a][1:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duck];[1:a]volume=1.6[vo];[vo][duck]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]',
  '-map',
  '0:v',
  '-map',
  '[a]',
  '-c:v',
  'copy',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-shortest',
  '-movflags',
  '+faststart',
  final,
);
console.log(final, `${total.toFixed(1)} s`, existsSync(final));
