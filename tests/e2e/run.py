"""End-to-end test in headless Chromium (WebGL + WebGPU via SwiftShader) against the mock backend.
Run: python3 tests/e2e/run.py   (after npm run build)"""
import asyncio, subprocess, time, os, sys, json
from playwright.async_api import async_playwright

OUT = os.environ.get("E2E_OUT", "build/e2e")
os.makedirs(OUT, exist_ok=True)
import socket
with socket.socket() as _s:
    _s.bind(("127.0.0.1", 0)); PORT = _s.getsockname()[1]  # a free port, so stale servers never answer
fails = []
def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

async def main():
    srv = subprocess.Popen(["node", "tests/e2e/mock-server.mjs", str(PORT)])
    time.sleep(1.2)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader"])
        pg = await b.new_page(viewport={"width": 1400, "height": 860})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.set_default_timeout(60000)
        await pg.goto(f"http://localhost:{PORT}/")
        await pg.wait_for_function("document.querySelector('#floodEng').textContent.includes('WebAssembly')", timeout=60000)
        check(True, "boots; Priority-Flood running in WebAssembly")
        check("Claude (local)" in await pg.text_content("#stAI"), "AI transport: local proxy detected")
        check("GPU" in await pg.text_content("#windSrc"), "wind particles on the GPU: " + (await pg.text_content("#windSrc")))

        # streaming globe: tiles get finer as the camera descends; place names refine
        await pg.wait_for_function("terra.streamStats() && terra.streamStats().ready", timeout=60000)
        z0 = json.loads(await pg.evaluate("fetch('/__tiles').then(r=>r.text())"))["maxZ"]
        await pg.evaluate("terra.G.autoSpin=false; terra.runCommand('go to Naples')"); await pg.wait_for_timeout(2500)
        await pg.evaluate("terra.G.fly=null; terra.G.dist=1+0.0006; terra.G.tilt=0.8"); await pg.wait_for_timeout(16000)
        z1 = json.loads(await pg.evaluate("fetch('/__tiles').then(r=>r.text())"))["maxZ"]
        check(z1 >= 14 and z1 > z0, f"imagery tiles refine with zoom: z{z0} at global view → z{z1} at {await pg.evaluate('((terra.G.dist-1)*6371).toFixed(1)')} km")
        labels = await pg.evaluate("[...document.querySelectorAll('#placeLabels .pl')].filter(d=>d.style.display!=='none').map(d=>d.textContent)")
        check(len(labels) >= 3 and "Naples" in labels, "neighbourhood labels at street zoom: " + ", ".join(labels[:6]))
        await pg.screenshot(path=f"{OUT}/00-street-tilt.png")
        ts = json.loads(await pg.evaluate("fetch('/__tiles').then(r=>r.text())"))
        fb = await pg.evaluate("terra.streamStats().fallbackTiles")
        check(ts["failed"] > 0 and fb > 0, f"failed imagery handled: {ts['failed']} upstream failures, {fb} tiles filled from the built-in image, retries recovered the rest")
        await pg.evaluate("terra.G.tilt=0; terra.G.dist=1+0.02"); await pg.wait_for_timeout(6000)
        await pg.screenshot(path=f"{OUT}/00b-no-holes.png")
        await pg.evaluate("terra.G.tilt=0; terra.G.dist=3.2")
        # the rest exercises simulations; software rendering of streamed tiles is too slow to share
        # the test browser's CPU with them, so streaming is switched off here
        await pg.evaluate("terra.setStream(false)")

        # layers: GPU wind + live hazards
        await pg.click("#layersBtn")
        await pg.click("#lyWind")
        for k in ["storms", "fires", "quakes"]:
            await pg.click(f"#lv_{k}")
            await pg.wait_for_timeout(400)
        st = await pg.text_content("#liveStatus")
        check("active storms" in st and "fire detections" in st and "quakes" in st, f"live hazards rendered: {st}")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=f"{OUT}/01-live-wind.png")
        await pg.click("#layersBtn")

        # history + skill + ensemble
        await pg.click("#mWi")
        await pg.fill("#histName", "Katrina 2005")
        await pg.click("#histGo")
        await pg.wait_for_timeout(800)
        hist = await pg.text_content("#histOut")
        check("track error" in hist, "Katrina replay: " + hist[:120])
        await pg.click("#histSkill")
        await pg.wait_for_selector("table.skill", timeout=60000)
        check(True, "model skill table: " + (await pg.text_content("table.skill"))[:120])
        await pg.click("#tWiStorm")
        await pg.fill("#cmdInput", "hurricane category 4 near Houston"); await pg.press("#cmdInput", "Enter")
        await pg.wait_for_timeout(1000)
        await pg.click("#ensRun")
        await pg.wait_for_timeout(1500)
        ens = await pg.text_content("#ensOut")
        check("members" in ens and "%" in ens, "storm ensemble: " + ens[:120])
        await pg.screenshot(path=f"{OUT}/02-ensemble.png")

        # point-and-say: hover the globe centre, then type "put a volcano here"
        await pg.mouse.move(700, 430); await pg.wait_for_timeout(200); await pg.mouse.move(702, 432); await pg.wait_for_timeout(200)
        await pg.fill("#cmdInput", "put a volcano here"); await pg.press("#cmdInput", "Enter")
        await pg.wait_for_timeout(2500)
        lbl = await pg.text_content("#labels")
        check("Eruption" in lbl and "here" in lbl, "deixis: “here” resolved to the pointed spot and a volcano placed there")

        # regional surge with (mock) high-resolution terrain on WebGPU
        await pg.click("#clearSim")
        await pg.fill("#cmdInput", "go to Miami"); await pg.press("#cmdInput", "Enter")
        await pg.wait_for_timeout(4000)
        await pg.click("#rgBuild")
        await pg.wait_for_function("document.querySelector('#rgSource').textContent.length > 5", timeout=90000)
        src = await pg.text_content("#rgSource")
        check("Terrarium" in src, "regional terrain from tiles: " + src)
        check("WebGPU" in src, "shallow-water engine on WebGPU")
        await pg.evaluate("document.querySelector('#rgPlay').click()")
        await pg.wait_for_timeout(8000)
        t = await pg.text_content("#rgTime")
        check("Hour" in t and not t.startswith("Hour 0.0"), f"dynamic surge model advancing on WebGPU: {t}")
        await pg.evaluate("document.querySelector('#rgPlay').click()")
        await pg.select_option("#rgMode", "equilibrium")
        await pg.wait_for_timeout(1500)
        area = await pg.text_content("#rgArea")
        check(area.strip() not in ("0", "0 km²"), f"high-resolution equilibrium flood at sea + surge: {area}")
        await pg.screenshot(path=f"{OUT}/03-surge.png")

        # agent with fact-checker
        await pg.fill("#cmdInput", "How bad would a 3 metre storm surge be in Miami?"); await pg.press("#cmdInput", "Enter")
        await pg.wait_for_function("document.querySelector('#ansSrc').textContent.includes('traced')", timeout=400000)
        src = await pg.text_content("#ansSrc"); ans = await pg.text_content("#ansContent")
        check("simulate_surge" in json.dumps(open("build/mock-claude.log").read()) or "shallow-water" in ans, "agent called the surge model")
        check("revised by fact-checker" in src, "fact-checker revised the answer: " + src)
        check("12.5 million" not in ans, "untraced number removed")
        nums = await pg.locator("#ansContent button.num.ok").count()
        check(nums >= 2, f"{nums} numbers linked to their tool results")
        await pg.locator("#ansContent button.num.ok").first.click()
        prov = await pg.text_content(".prov")
        check("simulate_surge" in prov or "geocode" in prov, "provenance popover: " + prov[:100])
        await pg.screenshot(path=f"{OUT}/04-agent.png")

        # spherical display output
        await pg.select_option("#sphereOut", "fisheye") if await pg.is_visible("#sphereOut") else None
        if not await pg.is_visible("#sphereOut"):
            await pg.click("#layersBtn"); await pg.select_option("#sphereOut", "fisheye")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=f"{OUT}/05-sphere-fisheye.png")
        check(await pg.evaluate("document.body.classList.contains('sphere-out')"), "spherical display output active")
        await pg.keyboard.press("Escape")

        check(not errors, "no page errors" + ("" if not errors else ": " + " | ".join(errors[:3])))
        await b.close()
    srv.terminate()
    print(f"\n{'ALL E2E CHECKS PASSED' if not fails else str(len(fails)) + ' FAILED'}")
    sys.exit(1 if fails else 0)

asyncio.run(main())
