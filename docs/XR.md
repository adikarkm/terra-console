# Running in a headset (Quest, Vision Pro)

WebXR, the camera and the microphone only work on secure origins: `https://…` or `http://localhost`. A headset browsing to your computer's LAN address over plain HTTP is not secure, so pick one of these.

## Option A — USB port forwarding (Quest, simplest)

1. Enable developer mode on the Quest and connect it by USB.
2. On the computer: `adb reverse tcp:3000 tcp:3000`
3. `npm start`, then open `http://localhost:3000` in the Quest browser. It counts as localhost, so WebXR works.

## Option B — local HTTPS certificate (Quest or Vision Pro over Wi-Fi)

1. Install [mkcert](https://github.com/FiloSottile/mkcert) and create a certificate for your computer's LAN IP:
   ```bash
   mkcert -install
   mkdir -p certs
   mkcert -cert-file certs/cert.pem -key-file certs/key.pem 192.168.1.20 localhost
   ```
2. In `.env`:
   ```
   CERT_FILE=./certs/cert.pem
   KEY_FILE=./certs/key.pem
   HTTPS_PORT=3443
   ```
3. `npm start` and open `https://192.168.1.20:3443` on the headset. Install mkcert's root certificate on the headset (or accept the warning) so the browser trusts it.

## Using it

- Press the **VR / AR** button in the right dock. AR passthrough is used when available.
- Pinch near the globe and move your hand to spin it; pinch with both hands to scale it.
- Point with your index finger, then pinch away from the globe to draw a region or place a storm or event.
- The floating panel has mode buttons, sea level ±1 m and an Exit button, and shows the latest AI answer.

## Status

Built on three.js WebXR (`renderer.xr`) with the WebXR Hand Input API. It has not been tested on physical hardware yet; expect to tune grab sensitivity (`k` in `xr.js`), pinch thresholds and panel placement on your device. Vision Pro's Safari exposes hands through transient-pointer input on some versions; controller-style `select` events are handled, so gaze-and-pinch should still draw and press buttons.

## Looking Glass

1. Install [Looking Glass Bridge](https://lookingglassfactory.com/software) and connect the display.
2. Open the console in Chrome on the same computer, Layers → **Looking Glass**. The polyfill (`@lookingglass/webxr` 0.6.0, loaded from jsDelivr on demand) opens a window on the display; the globe sits at the centre of the view volume.

## Physical spheres

Layers → **Spherical display**: *Fisheye* outputs a north-centred azimuthal equidistant image (internally projected globes); *Equirectangular* outputs a 2:1 map (Science On a Sphere and most media-server spheres). Put the browser full screen on the sphere's display output. The image spins with the console and includes floods and raster layers; 3D markers and labels are not drawn there.
