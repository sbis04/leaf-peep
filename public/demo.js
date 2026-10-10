// Scripted walkthroughs for recording demos, loaded only with ?demo=<mode>.
//   ?demo=score&photo=<url>   score a photo, then go back to the walk
//   ?demo=search&q=<text>     type a search and open the top match
//   ?demo=spot&spot=<i>       open the i-th spot in the list
// They drive the same functions the real buttons call, and show where a finger would tap.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

const css = document.createElement('style');
css.textContent = `
  .demo-tap { position: fixed; z-index: 99999; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
    background: rgba(255,255,255,.6); border: 2px solid rgba(31,26,20,.5); pointer-events: none;
    animation: demo-tap .7s ease-out forwards; }
  @keyframes demo-tap { from { transform: scale(.35); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }`;
document.head.append(css);

function tapOn(el) {
  const r = el.getBoundingClientRect();
  const t = document.createElement('div');
  t.className = 'demo-tap';
  t.style.left = `${r.left + r.width / 2}px`;
  t.style.top = `${r.top + r.height / 2}px`;
  document.body.append(t);
  setTimeout(() => t.remove(), 800);
}

async function tapThen(el, ms = 350) {
  tapOn(el);
  await sleep(ms);
  el.click();
}

export async function run({ mode, photoUrl, query, spot, submit, where }) {
  await sleep(3000);
  if (mode === 'score') {
    tapOn($('captureBtn'));
    await sleep(500);
    const blob = await fetch(photoUrl).then((r) => r.blob());
    await submit(new File([blob], 'tree.jpg', { type: 'image/jpeg' }), where);
    await sleep(4500);
    await tapThen($('doneBtn'));
  } else if (mode === 'search') {
    const input = $('findInput');
    tapOn(input);
    await sleep(400);
    for (const ch of query) { input.value += ch; input.dispatchEvent(new Event('input')); await sleep(65); }
    await sleep(500);
    $('findForm').requestSubmit();
    await sleep(3500);
    const first = document.querySelector('#spots li');
    if (first) await tapThen(first);
  } else if (mode === 'spot') {
    const li = document.querySelectorAll('#spots li')[spot];
    if (li) await tapThen(li);
  }
}
