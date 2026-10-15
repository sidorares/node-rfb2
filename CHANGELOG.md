# Changelog

## [1.1.0](https://github.com/sidorares/node-rfb2/compare/v1.0.0...v1.1.0) (2026-10-15)


### Features

* Extended Clipboard: clipboardEmpty, supports.unicodeClipboard, no stale client text ([#40](https://github.com/sidorares/node-rfb2/issues/40)) ([94fd8c7](https://github.com/sidorares/node-rfb2/commit/94fd8c70f668b37a14df6b49bca9b0c92072a8d7)), closes [#36](https://github.com/sidorares/node-rfb2/issues/36) [#37](https://github.com/sidorares/node-rfb2/issues/37)


### Bug Fixes

* build dist/ in prepare so installs from git work ([#39](https://github.com/sidorares/node-rfb2/issues/39)) ([a8bd4b8](https://github.com/sidorares/node-rfb2/commit/a8bd4b8929f50655a97f1e990add52e117e01566))

## [1.0.0](https://github.com/sidorares/node-rfb2/compare/v0.2.2...v1.0.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* rects arrive in bgrx unless pixelFormat is set (0.x echoed the server's format), every encoding is decoded to pixels, errors are RfbError objects, FBS recording moved to recordFbs()/replayFbs(), and Node.js 22.12 or later is required. The 0.x API (createConnection and its events) keeps working; see "Upgrading from 0.x" in the README.

### Features

* rewrite the RFB client in TypeScript ([d2171ed](https://github.com/sidorares/node-rfb2/commit/d2171ed93164af772cf2e36fcda4d83271ea96c5))

### 1.0.0 in detail

A rewrite in TypeScript. The 0.x API keeps working; see "Upgrading from 0.x" in the README for what changed.

#### Protocol

- Protocol versions 3.3, 3.7 and 3.8 are negotiated (0.x always answered 3.8); 3.889 (Apple) and 4.x
  (RealVNC) servers get 3.8. UltraVNC repeaters (`repeaterId`).
- Security types: VeNCrypt (Plain, TLSNone, TLSVnc, TLSPlain, X509None, X509Vnc, X509Plain), Apple Remote
  Desktop (macOS user login), RSA-AES (RA2, RA2ne, RA2_256, RA2ne_256), Tight, MS Logon II. VNC
  authentication uses a built-in DES, since OpenSSL 3 no longer offers single DES.
- Encodings: RRE, CoRRE, Hextile (0.x's was unfinished), Zlib, Tight (lossless, and JPEG through a
  `decodeJpeg` hook), TightPNG, TRLE, ZRLE. Every pixel encoding is decoded to pixels.
- Pseudo-encodings: ExtendedDesktopSize and SetDesktopSize, LastRect, DesktopName, X Cursor, Cursor With
  Alpha, VMware cursor and cursor position, PointerPos, QEMU and VMware LED state, QEMU extended key events,
  QEMU audio, QEMU pointer motion, ExtendedMouseButtons, Fence, ContinuousUpdates, Extended Clipboard (UTF-8
  clipboard), xvp, compression and JPEG quality levels.
- Server messages: EndOfContinuousUpdates, ServerFence (answered automatically), xvp, QEMU audio.

#### API

- `connect()` returns a promise; `createConnection()` and the 0.x events still work.
- The client chooses the pixel format (`pixelFormat`, default `bgrx`) instead of echoing the server's.
- `update` events mark the end of each FramebufferUpdate; `nextUpdate()` and `for await (... of
  client.updates())` (back-pressure: one outstanding request).
- Rects are typed (`type: 'pixels' | 'copy' | 'cursor' | ...`); cursors come as RGBA too.
- `Framebuffer`: a client-side copy of the screen (overlap-safe CopyRect, resizes, `toRgba()`).
- `RfbError` with a `code`; errors are emitted or rejected, never thrown from socket callbacks. Unknown
  server messages and encodings fail the connection instead of stalling it. A zero-length read (an empty
  cursor or clipboard) no longer waits for more data.
- `credentials` (async), `security` preference, `tls`, `timeout`, `signal`, `path` options.
- `keysyms` and `keysymFromChar()`; `qemuKeyEvent()`; `setDesktopSize()`; `enableContinuousUpdates()`;
  `fence()`; `xvp()`; `enableAudio()`.
- `recordFbs()` / `replayFbs()` replace the `out` / `in` options (FBS now in the standard rfbproxy layout).
- `createServer()` / `RfbServerConnection`: a usable server side (0.x's `rfbserver.js` started listening on
  import with a fixed password).

#### Project

- ES module with type declarations, built from `src/` with TypeScript; Node.js 22.12 or later
  (`require('rfb2')` works there too).
- Unit tests (node:test) for every decoder against encoders written from the spec, every security type
  against in-process servers, and the client state machine; integration tests against TigerVNC, x11vnc,
  TightVNC, TurboVNC and QEMU in Docker (`docker/`).
- GitHub Actions: lint, typecheck, build and unit tests on Linux, macOS and Windows with Node 22, 24 and 26;
  integration tests with the Docker servers; release-please opens the release PR, and merging it publishes
  to npm with provenance.

## 0.2.2 and earlier

See the git history.
