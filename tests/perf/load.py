"""Load-time benchmark: serves a build with gzip and opens it in headless Chromium on a throttled
connection (default 20 Mbit/s, 40 ms RTT). Reports bytes over the wire and time to first globe.
Run: python3 tests/perf/load.py [dist-dir] [mbps]"""
import asyncio, subprocess, sys, time, socket
from playwright.async_api import async_playwright
DIR = sys.argv[1] if len(sys.argv) > 1 else "dist"
MBPS = float(sys.argv[2]) if len(sys.argv) > 2 else 20
with socket.socket() as s: s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]
async def main():
    srv = subprocess.Popen(["node", "tests/perf/static-gzip.mjs", DIR, str(PORT)]); time.sleep(0.8)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        results = []
        for run in range(2):
            ctx = await b.new_context(viewport={"width": 1280, "height": 800})
            pg = await ctx.new_page()
            cdp = await ctx.new_cdp_session(pg)
            await cdp.send("Network.enable")
            await cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
            await cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 40, "downloadThroughput": MBPS * 125000, "uploadThroughput": 5 * 125000})
            total = {"b": 0}
            cdp.on("Network.loadingFinished", lambda e: total.__setitem__("b", total["b"] + e.get("encodedDataLength", 0)))
            # keep the comparison to the app itself: no map tiles or external services
            await pg.route("**/*", lambda r: r.continue_() if r.request.url.startswith(f"http://localhost:{PORT}") else r.abort())
            t0 = time.time()
            await pg.goto(f"http://localhost:{PORT}/", wait_until="commit")
            await pg.wait_for_function("window.terra && window.terra.G && window.terra.G.renderer && window.terra.G.renderer.info.render.frame > 2", timeout=180000, polling=50)
            t1 = time.time() - t0
            await pg.wait_for_timeout(1500)
            results.append((t1, total["b"]))
            await ctx.close()
        await b.close()
    srv.terminate()
    t, by = results[-1]
    print(f"{DIR}: first globe {t:.2f} s at {MBPS:g} Mbit/s · {by/1e6:.2f} MB over the wire (incl. lazy loads in the first 1.5 s)")
asyncio.run(main())
