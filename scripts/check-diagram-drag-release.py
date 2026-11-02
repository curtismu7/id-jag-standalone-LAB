#!/usr/bin/env python3
"""Browser check: a box dropped over a DISABLED button must not stay stuck to the pointer.

Chrome sends no mouseup to a disabled control, so a box released over one (Next on the last step, Back on the overview) never got
its mouseup from React Flow's drag handler and kept following the pointer. The page CSS gives disabled buttons pointer-events: none.

Run (needs the web build and a server, Python Playwright with Chromium):
  npm run build && MODE=mock PORT=4720 node server/src/index.js &
  python3 scripts/check-diagram-drag-release.py --base http://127.0.0.1:4720
Exit 0 = no stuck drag in any mode and viewport; exit 1 = at least one box stayed in React Flow's dragging state (or the check could not run).
"""
import argparse, sys
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--base', required=True)
ap.add_argument('--modes', default='mock,pf-as,pf-pf,byo,gateway-redeem')
ap.add_argument('--viewports', default='1440x900,375x812')
ap.add_argument('--repeat', type=int, default=2, help='drags per mode, viewport and disabled button')
a = ap.parse_args()

HIT = """([x,y,id])=>{const e=document.elementFromPoint(x,y); const n=e&&e.closest('.react-flow__node'); return !!n&&n.dataset.id===id}"""
DRAGGING = "()=>document.querySelectorAll('.react-flow__node.dragging').length"
POS = "(id)=>{const r=document.querySelector(`.react-flow__node[data-id=\"${id}\"]`).getBoundingClientRect(); return [r.x,r.y]}"

def grab(pg, skip):
    """a point on a node that is fully on the canvas and not covered by anything else"""
    return pg.evaluate("""([skip])=>{
      const c=document.querySelector('.react-flow').getBoundingClientRect();
      for(const el of document.querySelectorAll('.react-flow__node')){
        const id=el.dataset.id; if(skip.includes(id)) continue; const r=el.getBoundingClientRect();
        for(const fx of [.5,.3,.7,.15,.85]) for(const fy of [.5,.3,.7,.15,.85]){
          const x=r.x+r.width*fx, y=r.y+r.height*fy;
          if(x<c.x+8||x>c.right-8||y<c.y+8||y>c.bottom-8||y>innerHeight-4) continue;
          const e=document.elementFromPoint(x,y); const n=e&&e.closest('.react-flow__node');
          if(n&&n.dataset.id===id) return {id,x,y};
        }
      }
      return null}""", [skip])

failures, ran = [], 0
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for vp in a.viewports.split(','):
        w, h = (int(v) for v in vp.split('x'))
        pg = b.new_context(viewport={'width': w, 'height': h}).new_page()
        for mode in a.modes.split(','):
            for which in ('Back', 'Next'):
                # Back is disabled on the overview (step 0), Next on the last step
                pg.goto(f'{a.base}/diagram/{mode}')
                pg.wait_for_selector('.react-flow__node'); pg.wait_for_timeout(600)
                last = pg.locator('nav[aria-label="Steps"] button').count() - 1
                step = 0 if which == 'Back' else last
                if step:
                    pg.goto(f'{a.base}/diagram/{mode}?step={step}'); pg.wait_for_selector('.react-flow__node'); pg.wait_for_timeout(900)
                btn = pg.get_by_role('button', name=('◀ Back' if which == 'Back' else 'Next ▶'))
                if not btn.is_disabled():
                    failures.append(f'{vp} {mode} step {step}: the {which} button is not disabled here, the check cannot run'); continue
                skip, cell = [], 0
                for rep in range(a.repeat):
                    pg.evaluate("()=>{const c=document.querySelector('.react-flow').getBoundingClientRect(); window.scrollBy(0,c.top-4)}"); pg.wait_for_timeout(120)
                    g = grab(pg, skip)
                    bb = btn.bounding_box()
                    if not g or not bb or bb['y'] + bb['height'] > h:
                        if not cell: failures.append(f'{vp} {mode} step {step}: no grabbable box or the {which} button is out of view (cannot run)')
                        break  # a later repeat may find no further box in view: only a cell with no drag at all fails
                    skip.append(g['id'])
                    tx, ty = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
                    m = pg.mouse
                    m.move(g['x'], g['y']); m.down(); m.move(g['x'] + 6, g['y'] + 6)
                    for i in range(1, 13): m.move(g['x'] + 6 + (tx - g['x'] - 6) * i / 12, g['y'] + 6 + (ty - g['y'] - 6) * i / 12)
                    pg.wait_for_timeout(60); m.up(); pg.wait_for_timeout(300)
                    ran += 1; cell += 1
                    stuck = pg.evaluate(DRAGGING)
                    before = pg.evaluate(POS, g['id']); m.move(tx - 40, ty + 10); pg.wait_for_timeout(200); after = pg.evaluate(POS, g['id'])
                    follows = abs(after[0] - before[0]) + abs(after[1] - before[1]) > 3
                    if stuck or follows:
                        failures.append(f'{vp} {mode} step {step}: box {g["id"]} released over the disabled {which} button stayed stuck (dragging nodes {stuck}, follows pointer {follows})')
                    pg.get_by_role('button', name='Reset', exact=True).click(); pg.wait_for_timeout(400)
        pg.context.close()
    b.close()

print(f'{ran} drags released over a disabled button, {len(failures)} problem(s)')
for f in failures: print('FAIL', f)
sys.exit(1 if failures or not ran else 0)
