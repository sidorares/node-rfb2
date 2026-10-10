# RFB test servers (Docker)

Real VNC servers for node-rfb2's integration tests, each in a small Debian trixie container. Every
X server shows the same static, deterministic test card. The QEMU servers show a static VGA text
screen. A test can connect many times, decode the framebuffer with any encoding and compare pixels,
with each other or with the reference PNGs in [`assets/`](assets).

> **TEST-ONLY.** The passwords, the Unix user and the TLS/RSA keys in [`certs/`](certs) are public,
> because they are committed to this repository. Never reuse them, and never publish these ports
> beyond `127.0.0.1`.

```sh
docker compose -f docker/compose.yaml up -d --build --wait   # build, start, wait until all are healthy
node docker/probe.mjs --all                                  # log in to each one and check its screen
docker compose -f docker/compose.yaml down                   # stop and remove
```

`--wait` returns once every healthcheck passes. A service is healthy when its screen is set up and
its port answers with an `RFB 00x.00y` banner (`bin/rfb2-healthcheck`). Starting takes about 3 s
once the images are built. The first build takes a few minutes.

The images build natively for amd64 (GitHub Actions `ubuntu-latest`) and arm64 (Apple Silicon).
Everything comes from Debian packages, except TurboVNC, which uses the official release `.deb` for
the build architecture (pinned version and SHA-256). The Debian base image is pinned by date. To
pin every package version as well, pass `--build-arg DEBIAN_SNAPSHOT=20260918T000000Z`, which
installs from snapshot.debian.org.

## Services

Ports are published on `127.0.0.1` only, in the 159NN range, so they can't collide with real VNC
servers on 59NN. To move a port, set `RFB2_PORT_<SERVICE>`, for example
`RFB2_PORT_TIGERVNC=25901` or `RFB2_PORT_X11VNC_VNC=25911`; `probe.mjs --all` reads the same
variables. Inside each container the server listens on 59NN.

Every server speaks **RFB 3.8**, and its ServerInit pixel format is the same: **32 bpp, depth 24,
little-endian, true colour, red/green/blue max 255 at shifts 16/8/0**.

| Service | Port | Server | Security types offered | Credentials | ServerInit size, name |
|---|---|---|---|---|---|
| `tigervnc` | 15901 | TigerVNC Xvnc 1.15.0 (Debian `1.15.0+dfsg-2.1~deb13u1`) | 1 None | none | 1000x750, `rfb2 tigervnc` |
| `tigervnc-vnc` | 15902 | TigerVNC Xvnc 1.15.0 | 2 VncAuth | password `rfb2test` | 1000x750, `rfb2 tigervnc-vnc` |
| `tigervnc-vencrypt` | 15903 | TigerVNC Xvnc 1.15.0 | 19 VeNCrypt, 2 VncAuth. VeNCrypt 0.2 subtypes: 262 X509Plain, 261 X509Vnc, 260 X509None, 259 TLSPlain, 258 TLSVnc, 257 TLSNone, 256 Plain, 2 VncAuth | password `rfb2test`; Plain types: user `rfb`, password `rfb2test`; X509: CA `certs/test-ca.pem` | 1000x750, `rfb2 tigervnc-vencrypt` |
| `tigervnc-ra2` | 15904 | TigerVNC Xvnc 1.15.0 | 129 RA2_256, 5 RA2, 130 RA2ne_256, 6 RA2ne | password only (`rfb2test`) | 1000x750, `rfb2 tigervnc-ra2` |
| `tigervnc-ra2-user` | 15905 | TigerVNC Xvnc 1.15.0, `-RequireUsername` | 129 RA2_256, 5 RA2, 130 RA2ne_256, 6 RA2ne | user `rfb`, password `rfb2test` | 1000x750, `rfb2 tigervnc-ra2-user` |
| `x11vnc` | 15910 | x11vnc 0.9.17 (libvncserver 0.9.15) on Xvfb 21.1.16 | 1 None | none | 1000x750, `rfb2 x11vnc` |
| `x11vnc-vnc` | 15911 | x11vnc 0.9.17 | 2 VncAuth | password `rfb2test` | 1000x750, `rfb2 x11vnc-vnc` |
| `tightvnc` | 15920 | TightVNC Xtightvnc 1.3.10 (Debian `1:1.3.10-9+b1`) | 2 VncAuth, 16 Tight (Tight auth: 2 VNCAUTH) | password `rfb2test` | 1000x750, `rfb's rfb2 tightvnc desktop (tightvnc:1)` |
| `tightvnc-none` | 15921 | TightVNC Xtightvnc 1.3.10 | 1 None, 16 Tight (no auth types) | none | 1000x750, `rfb's rfb2 tightvnc-none desktop (tightvnc-none:1)` |
| `turbovnc` | 15930 | TurboVNC Xvnc 3.3.1 (official `.deb`) | 1 None, 16 Tight (Tight auth: 1 NOAUTH) | none | 1000x750, `rfb2 turbovnc` |
| `qemu` | 15940 | QEMU 10.0.13 built-in VNC server (Debian `1:10.0.13+ds-0+deb13u1`) | 1 None | none | 720x400, `QEMU (rfb2 qemu)` |
| `qemu-vnc` | 15941 | QEMU 10.0.13 | 2 VncAuth | password `rfb2test` | 720x400, `QEMU (rfb2 qemu-vnc)` |

TightVNC formats the desktop name itself: `<user>'s <-desktop> desktop (<hostname>:1)`. Each service
has a fixed hostname, so the name stays the same.

### Encodings and pseudo-encodings

The encoding lists come from each server's source code or its own Tight capability list. "Acked"
means the server sent that pseudo-encoding back, or a message for it, right after the client asked
for it (`SetEncodings [Raw, X]` followed by an update request). Others only show up on a change:
DesktopSize, DesktopName, PointerPos (when the pointer moves), and so on.

| Server | Encodings | Pseudo-encodings |
|---|---|---|
| TigerVNC 1.15 | Raw, CopyRect, RRE, Hextile, Tight (with JPEG), ZRLE | acked: Cursor -239, XCursor -240, CursorWithAlpha -314, VMwareCursor, VMwareLEDState, LEDState -261, LastRect -224, QEMU ExtendedKeyEvent -258, ExtendedDesktopSize -308, Fence -312 (message 248), ExtendedMouseButtons -316, ExtendedClipboard (ServerCutText with caps). Also: DesktopSize, DesktopName, ContinuousUpdates, VMwareCursorPosition, compress / quality / fine quality / subsampling levels |
| libvncserver 0.9.15 (x11vnc) | Raw, CopyRect, RRE, CoRRE, Hextile, Zlib, Tight, TightPng, Ultra, ZRLE, ZYWRLE | acked: Cursor, XCursor, ExtendedDesktopSize, SupportedMessages, SupportedEncodings, ServerIdentity (0xFFFE0001-3). Also: PointerPos -232 (`-cursorpos`), LastRect, DesktopSize, KeyboardLedState, compress / quality levels |
| TightVNC 1.3.10 | Raw, CopyRect, RRE, CoRRE, Hextile, Zlib, Tight (with JPEG); **no ZRLE** | acked: Cursor, XCursor. Also: PointerPos, LastRect, DesktopSize, compress / quality levels |
| TurboVNC 3.3.1 | Raw, CopyRect, RRE, CoRRE, Hextile, Zlib, ZRLE, ZYWRLE, Tight (TurboVNC's JPEG variant) | acked: Cursor, XCursor, ExtendedDesktopSize, Fence, ExtendedMouseButtons, ExtendedClipboard, GII -305 (message 253). Also: PointerPos, LastRect, DesktopSize, ContinuousUpdates, compress / quality / fine quality -512 / subsampling -768 levels |
| QEMU 10.0 | Raw, Hextile, Zlib, Tight (JPEG, gradient), TightPNG -260, ZRLE, ZYWRLE; **no CopyRect** | acked: QEMU PointerMotionChange -257, QEMU ExtendedKeyEvent -258, QEMU Audio -259, LEDState -261, ExtendedDesktopSize, xvp -309 (message 250; `qemu` only), ExtendedClipboard. Also: DesktopSize, Cursor, CursorWithAlpha, WMVi, compress / quality levels |

QEMU audio: both QEMU services have VNC audio capture (`-audiodev none,id=snd0`, `-vnc …,audiodev=snd0`).
The QEMU audio messages (client message 255, submessage 1: enable, disable, set format) are
accepted. But the VM has no sound device and its guest never plays anything, so no audio data
arrives. `qemu` also has `power-control=on` (the XVP extension). An XVP reboot or reset restarts
the VM into the same screen; XVP shutdown does nothing, because there is no OS to power down.

## The screen

### X servers (TigerVNC, x11vnc/Xvfb, TightVNC, TurboVNC): `assets/testcard.png`

The screen is 1000x750, depth 24, a size that is deliberately not a multiple of 16. The test card
is the root window background, drawn 1:1, and **the framebuffer equals `assets/testcard.png`
pixel for pixel** (`probe.mjs --compare` checks this). No window manager runs, so nothing on the
screen moves. The screen saver and DPMS are off. The X servers run with `-noreset`, and
`rfb2-xsetup` keeps its resources, so the screen survives clients coming and going.

`assets/make-testcard.mjs` generates the card deterministically: plain Node, no dependencies,
seeded PRNG. It has 1-pixel white edges with 4x4 coloured corner markers (top-left red, top-right
green, bottom-left blue, bottom-right magenta) and twelve panels, none of them aligned to the
16- or 64-pixel tile grid:

- a large solid area
- colour bars
- a 2-D gradient
- 2-colour glyph text from a 5x7 font
- checkerboards and stripes
- 12 colours in random rectangles
- about 100 colours in horizontal runs
- seeded full-colour noise
- sharp shapes on a solid background
- grey, red, green and blue horizontal ramps
- a vertical ramp

**Cursor.** `assets/cursor.png` is a 12x19 two-colour arrow. Its foreground is rgb(20,40,160) and
its background rgb(255,230,80). The hotspot is the bottom-right pixel (11,18), which is
transparent. The pointer is parked at **(0,0)**, so a cursor that a server draws into the
framebuffer covers only that one transparent pixel, and the framebuffer still equals the test card.
All four X servers send this exact cursor to clients that ask for Cursor -239 or XCursor -240; the
rect's x,y is the hotspot, (11,18). `assets/cursor.xbm` and `cursor-mask.xbm` are the X bitmaps
it is made from.

**Keep it static.** If a test moves the pointer with a PointerEvent, the servers draw the cursor
somewhere else in the framebuffer. That draw is visible to every later client that doesn't ask for
cursor shapes, and the pointer stays where the test left it. **Tests that move the pointer must
send it back to (0,0)** when they finish. Key events change nothing, because no application runs.

Server quirks around the cursor:

- **TigerVNC** draws the cursor into the framebuffer and sends the client an *empty* (0x0) cursor
  while the pointer isn't where that client last put it. A new client counts as having put it at
  (0,0), which is why the pointer is parked there. TigerVNC also crops fully transparent borders
  from cursors; this one has none to crop.
- **TurboVNC**, for a client that asked for a cursor pseudo-encoding, answers every incremental
  update request with a 9x9 Raw/… rect at the pointer, (0,0). Its pixels never change.
- **x11vnc** only polls the X display while a client is connected. It also avoids XFIXES, which
  gives the real cursor shape, until it believes a window manager is running. Its start script
  therefore sets `X11VNC_AVOID_WINDOWS=never` and runs one warm-up session
  (`bin/rfb2-x11vnc-warmup`) before the container reports healthy.

### QEMU: `assets/qemu-bootcard.png`

The VM is an x86 PC with std VGA and no other devices, running under TCG. It boots
`src/bootcard.asm`, a 512-byte boot sector assembled with nasm when the image is built and stored
on a 1.44 MB floppy image. The boot sector:

1. sets 80x25 text mode, which QEMU shows as 720x400 with 9x16 cells;
2. hides the text cursor (int 10h AH=01h, CX=2000h);
3. turns attribute blinking into bright backgrounds (int 10h AX=1003h, BL=0);
4. fills the screen with a title line, a text line, all 256 colour attributes (16x16 cells of █▓▒░
   plus a letter), all 256 code page 437 glyphs, single- and double-line box drawing, and a solid
   red area;
5. writes `rfb2-bootcard ready` to the debug port 0x402, which the start script waits for;
6. halts with interrupts off.

The screen never changes. `assets/qemu-bootcard.png` is a capture of it; tests can compare against
it. To refresh it after changing the boot card:
`node docker/probe.mjs 15940 --png docker/assets/qemu-bootcard.png`.

## Security details

- **VncAuth.** The DES key is the password with each byte's bits reversed. Node's OpenSSL 3 has no
  `des-ecb` without the legacy provider, but `des-ede3` with the key repeated 3 times is
  equivalent; `probe.mjs` does this.
- **TigerVNC anonymous TLS** (TLSNone, TLSVnc, TLSPlain) works only with **TLS 1.2 and an
  anonymous ECDH suite**. In Node, use
  `{ maxVersion: 'TLSv1.2', ciphers: 'AECDH-AES256-SHA:AECDH-AES128-SHA:@SECLEVEL=0' }`
  (or `'aNULL:@SECLEVEL=0'`); the result is `TLS_ECDH_anon_WITH_AES_256_CBC_SHA`. If TLS 1.3 is
  allowed, the server resets the connection. `ADH-*` (anonymous DH) suites are refused: GnuTLS has
  no DH parameters for them. Without `@SECLEVEL=0`, OpenSSL won't offer anonymous suites at all.
- **TigerVNC X509\*** negotiates TLS 1.3 (`TLS_AES_256_GCM_SHA384`). The server certificate is
  `certs/test-server.pem` (CN `localhost`; SAN `DNS:localhost`, `IP:127.0.0.1`, `IP:::1`; RSA 2048;
  valid until 2126), issued by `certs/test-ca.pem`. Verify with `ca: test-ca.pem`. `make-certs.sh`
  regenerates the CA and server certificate; commit the output.
- **Plain, TLSPlain, X509Plain** use PAM, service `tigervnc` (`-PAMService tigervnc`). Debian
  ships `/etc/pam.d/tigervnc`, while Xvnc's default service is `vnc`, which doesn't exist. Only user
  `rfb` (password `rfb2test`) can log in. `-PlainUsers rfb` allows only that user, and Xvnc runs as
  `rfb`: pam_unix's helper `unix_chkpwd` can only check the password of the user it runs as.
- **RA2, RA2ne, RA2_256, RA2ne_256** (RSA-AES) use `certs/test-server-key.pem` as the server's
  2048-bit RSA key (`-RSAKey`); Xvnc has no default key. Which credentials they ask for depends on
  `-RequireUsername`:
  - off (`tigervnc-ra2`): the server sends subtype 2, password only, checked against the VncAuth
    password `rfb2test`;
  - on (`tigervnc-ra2-user`): the server sends subtype 1, username + password, checked by PAM
    like Plain (`rfb` / `rfb2test`).

  `probe.mjs` only reads the server's public key for these types; it doesn't do the AES-EAX
  exchange.
- **Failed logins.** TigerVNC runs with `-UseBlacklist=0`, so tests can fail authentication as
  often as they like. x11vnc and QEMU don't block either. **TightVNC 1.3 cannot be configured:
  after 5 failed logins in a row it refuses every connection** with "Too many authentication
  failures" for 10 s. Each further failure doubles the wait; a successful login resets the count.
  So keep wrong-password tests against `tightvnc` to at most 4 in a row.
- Every server treats every client as shared (`-AlwaysShared`, `-shared`, `-alwaysshared`, QEMU
  `share=force-shared`), so concurrent tests don't disconnect each other, whatever their
  ClientInit shared flag.

## Latency

These are typical times on an M1 Pro (Docker Desktop) from the TCP connect to the last byte of a
full 1000x750 Raw frame:

| Server | Time |
|---|---|
| TigerVNC, TightVNC | 30–70 ms |
| QEMU | ~110 ms |
| TurboVNC | ~150 ms |
| x11vnc | ~150–220 ms |

x11vnc and TurboVNC wait about 100 ms before sending the banner, while libvncserver checks whether
the client speaks WebSocket. x11vnc's defaults were much slower: about 0.5 s for each new client,
and 1.5–4 s once it had been idle for a minute. Its start script now uses
`-threads -nonap -sb 0 -wait 10 -defer 10`; see the comments in `bin/start-x11vnc`.

## probe.mjs

```sh
node docker/probe.mjs --all                                   # every service, with credentials and screen check
node docker/probe.mjs 15901 --png /tmp/fb.png                 # banner, security types, ServerInit, one Raw frame
node docker/probe.mjs 15903 --vencrypt 259 --user rfb --password rfb2test
node docker/probe.mjs localhost:15903 --vencrypt 261 --password rfb2test --ca docker/certs/test-ca.pem
node docker/probe.mjs 15921 --sec 16                          # Tight security type: lists Tight capabilities
node docker/probe.mjs 15910 --compare docker/assets/testcard.png
```

It is plain Node with no dependencies. It answers the banner with the highest version ≤ 3.8 and
prints the offered security types, with VeNCrypt subtypes and Tight capabilities where relevant.
It authenticates with None, VncAuth, Tight, or VeNCrypt with any subtype; for RA2 it only prints
the RSA key. It then prints ServerInit and timings. With `--png` / `--compare`, it sets a 32-bpp
pixel format and `SetEncodings [Raw]`, fetches one non-incremental full update, and writes or
compares it. The exit status is 2 when the pixels differ.

## Files

| Path | What |
|---|---|
| `compose.yaml` | the services; `name: rfb2-test`, images `rfb2-test/<server>:local` |
| `Dockerfile` | one build target per server, plus `build` (rfb2-xsetup, PPM, boot card) and `turbovnc-fetch` |
| `bin/start-*` | per-server start scripts, configured with `RFB_PORT`, `SECURITY_TYPES`, `VNC_PASSWORD`, `REQUIRE_USERNAME`, `DESKTOP_NAME`, … |
| `bin/rfb2-healthcheck` | healthcheck: setup done and the RFB banner (bash `/dev/tcp`) |
| `bin/rfb2-x11-setup`, `src/rfb2-xsetup.c` | puts the test card, cursor and pointer position on an X display (Xlib, built in the image) |
| `bin/rfb2-x11vnc-warmup` | x11vnc's warm-up session (Perl; DES through openssl) |
| `src/bootcard.asm` | QEMU boot sector |
| `assets/make-testcard.mjs` | generates `testcard.png`, `cursor.png`, `cursor.xbm`, `cursor-mask.xbm` |
| `assets/qemu-bootcard.png` | capture of the QEMU screen |
| `certs/make-certs.sh` | generates the TEST-ONLY CA and server certificate / key |
| `probe.mjs` | the probe |

To change the test card, edit `make-testcard.mjs`, run it, rebuild (`up --build`), and commit the
outputs.
