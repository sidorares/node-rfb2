# rfb2

[![CI](https://github.com/sidorares/node-rfb2/actions/workflows/ci.yml/badge.svg)](https://github.com/sidorares/node-rfb2/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rfb2.svg)](https://www.npmjs.com/package/rfb2)

An [RFB](https://github.com/rfbproto/rfbproto) (VNC) client and server for Node.js, in TypeScript with no
runtime dependencies. It speaks to TigerVNC, TightVNC, TurboVNC, x11vnc/libvncserver, QEMU, macOS Screen
Sharing, RealVNC and UltraVNC, and decodes every common encoding to pixels in the format you choose.

```js
import { connect, Framebuffer, buttons, keysyms } from 'rfb2'

const client = await connect({ host: '127.0.0.1', port: 5900, password: 'secret' })
console.log(`${client.name}: ${client.width}×${client.height}`)

const screen = Framebuffer.attach(client) // a copy of the remote screen, kept up to date

// Updates with back-pressure: the next one is requested when you ask for it.
for await (const update of client.updates()) {
  console.log(`${update.rects.length} rects`)
  const rgba = screen.toRgba() // for a canvas, a PNG encoder, a template matcher...
  break
}

client.pointerEvent(100, 100, buttons.left) // button down
client.pointerEvent(100, 100, 0) // and up
client.keyEvent(keysyms.Return, true)
client.keyEvent(keysyms.Return, false)
client.updateClipboard('héllo ☃') // UTF-8 when the server has the Extended Clipboard

await client.close()
```

Node.js 22.12 or later. The package is an ES module and also loads with `require('rfb2')`.

## What's supported

| | |
|---|---|
| Protocol versions | 3.3, 3.7, 3.8 (Apple's 3.889 and RealVNC's 4.x get 3.8) |
| Security types | None, VNC password, Apple Remote Desktop (macOS user login), VeNCrypt (Plain, TLSNone/Vnc/Plain, X509None/Vnc/Plain), RSA-AES (RA2, RA2ne, RA2_256, RA2ne_256), Tight, MS Logon II (UltraVNC); UltraVNC repeaters |
| Encodings | Raw, CopyRect, RRE, CoRRE, Hextile, Zlib, Tight (lossless, and JPEG with a decoder you plug in), TightPNG, TRLE, ZRLE |
| Pseudo-encodings | DesktopSize, ExtendedDesktopSize (+ SetDesktopSize), LastRect, DesktopName, Cursor, X Cursor, Cursor With Alpha, VMware cursor, cursor position (PointerPos, VMware), QEMU and VMware LED state, QEMU extended key events, QEMU audio, QEMU pointer motion, ExtendedMouseButtons, Fence, ContinuousUpdates, Extended Clipboard (UTF-8), xvp, compression and JPEG quality levels |
| Pixel formats | any true-colour or colour-map format of 8, 16 or 32 bits, either byte order |

Every decoder is tested against encoders written from the specification, and every encoding against
real TigerVNC, x11vnc, TightVNC, TurboVNC and QEMU servers in Docker (see [Development](#development)).

## Connecting

`connect(options)` resolves with a connected `RfbClient` (or rejects with an `RfbError`).
`new RfbClient(options)` starts connecting at once and emits `connect`; `createConnection(options)`
is the 0.x name for it.

| Option | Default | |
|---|---|---|
| `host`, `port` | `127.0.0.1`, `5900` | |
| `path` | | a Unix socket instead |
| `stream` | | any duplex stream instead: a proxy, a WebSocket stream, a reverse connection, an FBS replay |
| `password`, `username` | | `username` is for the types that log in a user (ARD, VeNCrypt Plain, RSA-AES, MS Logon II) |
| `credentials` | | `async ({ securityType, needs }) => ({ username, password })`, asked for what's missing |
| `security` | all, by the credentials given | security types (`security.*`) in order of preference; VeNCrypt subtypes such as `security.X509Vnc` select VeNCrypt |
| `tls` | | `tls.connect()` options for the VeNCrypt X509 subtypes, e.g. `{ ca, servername }` |
| `encodings` | `defaultEncodings` | encodings and pseudo-encodings to offer, best first |
| `pixelFormat` | `'bgrx'` | `'bgrx'`, `'rgbx'`, `'rgb565'`, `'bgr233'`, a `PixelFormat`, or `'server'` for the server's own |
| `shared` | `true` | `false` asks the server to disconnect other clients |
| `initialUpdate` | `true` | request the whole screen right after connecting |
| `autoUpdate` | `false` | request the next incremental update after each update |
| `decodeJpeg` | | turns Tight JPEG rects into pixels (see [JPEG](#jpeg)) |
| `timeout` | none | fail with `TIMEOUT` when the handshake takes longer (ms) |
| `signal` | | an `AbortSignal` that closes the connection |
| `repeaterId` | | the ID to send to an UltraVNC repeater, e.g. `'ID:1234'` |
| `maxVersion` | `'3.8'` | the highest protocol version to agree to |

After `connect`: `width`, `height`, `name`, `pixelFormat`, `serverPixelFormat`, `protocolVersion`,
`serverVersion`, `securityType`, `screens`, `colorMap`, `cursor`, and `supports` (what the server has
confirmed: `extendedDesktopSize`, `continuousUpdates`, `fence`, `extendedClipboard`, `qemuExtendedKeyEvent`,
`qemuAudio`, `extendedMouseButtons`, `xvp`).

### Security

Without a `security` option the client takes the first type the server offers from: None, the VNC
password types, RSA-AES, then the user-login types (ARD, VeNCrypt Plain, MS Logon II) — or the user-login
types first when a `username` is given, which is what macOS Screen Sharing wants:

```js
// macOS: System Settings → Sharing → Screen Sharing; log in as a user of the Mac.
const mac = await connect({ host: 'my-mac.local', username: 'me', password: '…' })

// TigerVNC with a certificate:
const tls = await connect({ host, security: [security.X509Vnc], password, tls: { ca: readFileSync('ca.pem') } })
```

The anonymous TLS subtypes (TLSNone, TLSVnc, TLSPlain) encrypt but can't authenticate the server, and RSA-AES
doesn't verify the server's key either.

## Updates and rects

Each FramebufferUpdate emits a `rect` event per rect, then an `update` event with all of them. Every
rect has `type`, `x`, `y`, `width`, `height` and the wire `encoding`:

| `type` | | |
|---|---|---|
| `pixels` | `data` | `width * height` pixels in `client.pixelFormat`, whatever the encoding (Raw, Hextile, ZRLE, Tight, ...) |
| `copy` | `src` | CopyRect: copy from `src.x`, `src.y` (in the framebuffer as it is at that point) |
| `jpeg` | `jpeg` | Tight JPEG data, when there's no `decodeJpeg` |
| `cursor` | `rgba` | a new cursor shape (`x`, `y` is the hotspot); also the `cursor` event |
| `desktopSize`, `extendedDesktopSize` | `screens`, `reason`, `status` | the framebuffer changed size; also `resize` |
| `desktopName` | `name` | also the `desktopName` event |
| `cursorPosition`, `ledState`, `pointerMotion`, `cursorState`, `capability` | | server notifications |

Apply rects in order. `Framebuffer` does it for you, CopyRect and resizes included:

```js
const fb = Framebuffer.attach(client) // or new Framebuffer(w, h, pixelFormat) and fb.apply(rect)
fb.data // the screen in fb.pixelFormat; fb.toRgba() converts it
```

Ways to ask for updates:

- `requestUpdate(incremental = true, x, y, width, height)` (whole screen by default) and the `update` event;
  `nextUpdate()` resolves with the next update.
- `for await (const update of client.updates())`: requests the next update only when you take the previous
  one, so a slow consumer never falls behind (the first request is non-incremental).
- `autoUpdate: true`: a new incremental request after every update.
- `enableContinuousUpdates()` when `supports.continuousUpdates`: the server sends updates unasked.

### JPEG

Tight JPEG is lossy and only used when you offer a quality level (`jpegQuality(0..9)` or
`jpegFineQuality(1..100)` in `encodings`). Bring a decoder that returns RGB or RGBA pixels:

```js
import jpeg from 'jpeg-js'

const client = await connect({
  encodings: [encodings.tight, jpegQuality(7), ...defaultEncodings],
  decodeJpeg: (data) => jpeg.decode(data, { useTArray: true }).data,
})
```

## Input and other messages

| | |
|---|---|
| `pointerEvent(x, y, buttons)` | `buttons.left \| buttons.right ...`; the wheel is a press and release of `buttons.wheelUp` / `wheelDown` |
| `keyEvent(keysym, down)` | X11 keysyms: `keysyms.Return`, `keysymFromChar('é')`, ... |
| `qemuKeyEvent(keysym, scancode, down)` | QEMU: XT scancodes, independent of the server's keymap |
| `updateClipboard(text)` | UTF-8 with the Extended Clipboard, else Latin-1 |
| `setDesktopSize(width, height, screens?)` | resolves when the server has resized |
| `setEncodings(list)` | change the encodings mid-session |
| `fence(flags, payload)`, `xvp('reboot')`, `enableAudio(format)` / `disableAudio()` | |
| `close()`, `end()`, `destroy()` | `close()` resolves once closed |

Events: `connect`, `rect`, `update`, `resize`, `cursor`, `cursorPosition`, `desktopName`, `ledState`,
`colormap`, `bell`, `clipboard`, `fence`, `xvp`, `audio`, `endOfContinuousUpdates`, `error`, `close`.

## Errors

Errors are `RfbError`s with a `code` you can switch on, and messages that say what to do next. `reason`
holds the server's own explanation when it sent one.

`CONNECTION_FAILED`, `CONNECTION_CLOSED`, `TIMEOUT`, `ABORTED`, `NOT_RFB`, `UNSUPPORTED_VERSION`,
`SERVER_REFUSED`, `UNSUPPORTED_SECURITY`, `AUTH_REQUIRED`, `AUTH_FAILED`, `TLS_FAILED`,
`UNSUPPORTED_ENCODING`, `UNSUPPORTED_MESSAGE`, `UNSUPPORTED_BY_SERVER`, `PROTOCOL_ERROR`, `INVALID_ARGUMENT`.

During the handshake they reject `connect()` (or are emitted as `error`). Afterwards they're `error` events,
followed by `close`. A server that closes the connection between messages just causes `close`.

## Recording

`recordFbs(socket, file)` records what a server sends in the FBS format (rfbproxy, vncrec);
`replayFbs(recording, { speed })` plays it back as a stream for `connect({ stream })`:

```js
const socket = net.connect(5900, host)
recordFbs(socket, fs.createWriteStream('session.fbs'))
const client = await connect({ stream: socket })
// later
const replay = await connect({ stream: replayFbs(fs.readFileSync('session.fbs'), { speed: 1 }) })
```

## Server

`createServer(options, onConnection)` is a TCP server; `RfbServerConnection` the server side of one
connection over any stream. It does the handshake (None, or VNC authentication with `password`), parses
the client's messages into events (`setPixelFormat`, `setEncodings`, `updateRequest`, `key`, `pointer`,
`clipboard`) and sends updates converted to the client's pixel format:

```js
createServer({ width: 640, height: 480, name: 'node', password: 'secret' }, (conn) => {
  conn.on('updateRequest', ({ incremental }) => {
    if (!incremental) conn.sendUpdate([{ type: 'pixels', x: 0, y: 0, width: 640, height: 480, data: frame }])
  })
  conn.on('key', ({ keysym, down }) => {})
}).listen(5900)
```

Rects go out Raw (or CopyRect, DesktopSize, Cursor, or pre-encoded with `{ type: 'encoded' }`).

## Upgrading from 0.x

The 0.x API still works: `createConnection()`, the `connect`, `rect`, `resize`, `clipboard`, `bell` and
`error` events, `requestUpdate(incremental, x, y, w, h)`, `pointerEvent`, `keyEvent`, `updateClipboard`,
`end()`, `title`, `rect.data` for Raw and `rect.src` for CopyRect, and the pixel format fields (`bpp`,
`redShift`, ...). What changed:

- **Pixel format:** rects come in `bgrx` (32-bit little-endian 0x00RRGGBB) unless you set `pixelFormat`;
  0.x echoed the server's own format (`pixelFormat: 'server'` does that).
- **Every encoding is decoded:** Hextile, ZRLE, Tight, ... arrive as `type: 'pixels'` rects with `data`.
  The default encodings now include them; 0.x offered Raw and CopyRect only.
- **Errors** are `RfbError` objects (0.x emitted strings for server errors) and are never thrown from socket
  callbacks.
- `params.in` / `params.out` (FBS replay and recording) became `replayFbs()` / `recordFbs()`.
- The `rfbclient.js`, `unpackstream.js` and `d3des.js` files are gone; import from `rfb2`.
- Node.js 22.12 or later.

## Development

```bash
npm install
npm run check              # lint (Biome), typecheck (tsc), unit tests (node:test)
npm run build              # dist/ for publishing
npm run servers:up         # VNC servers in Docker on 127.0.0.1:159xx (see docker/README.md)
npm run test:integration   # every encoding, pixel format and security type against them
npm run servers:down
```

The sources run directly on Node (type stripping): `node examples/screenshot.ts host 5900 > screen.png`.

Integration tests skip servers that aren't running; CI starts them all (`.github/workflows/ci.yml`).
Releases are published to npm from GitHub releases (`.github/workflows/release.yml`).

## See also

- [rfbproto](https://github.com/rfbproto/rfbproto): the community RFB specification
- [vnc-rfb-client](https://github.com/filipecbmoc/vnc-rfb-client)
- [node-rfb](https://github.com/substack/node-rfb): Substack's implementation of the RFB protocol
- [VNC client in 200 lines of JavaScript](http://blog.mgechev.com/2013/08/30/vnc-javascript-nodejs/): a blog post and [HTML5 client](https://github.com/mgechev/js-vnc-demo-project) using node-rfb2
- [vnc-over-gif](https://github.com/sidorares/vnc-over-gif): stream your screen to an animated GIF
- [rfbrecord](https://github.com/sidorares/rfbrecord): stream a VNC connection to a video file
- [ansi-vnc](https://npmjs.org/package/ansi-vnc): a terminal VNC client
- [node-vnc](https://github.com/sidorares/node-vnc): a graphical VNC client for X Window using the [node X11 client](https://github.com/sidorares/node-x11)
- [vnc.js](https://github.com/bgaff/vnc.js): a LinkedIn intern [hackday 2011 project](http://engineering.linkedin.com/javascript/vncjs-how-build-javascript-vnc-client-24-hour-hackday)
- [rdpy](https://github.com/citronneur/rdpy): RFB and RDP in Python

## License

MIT
