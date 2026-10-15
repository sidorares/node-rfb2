import buffer from 'node:buffer'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type tls from 'node:tls'
import zlib from 'node:zlib'
import { audioFormats, encodings as E, fenceFlags, security as S, serverMsgTypes, xvpCodes } from './constants.ts'
import { Decoder, isKnownEncoding, pixelEncodings } from './decoder.ts'
import type { JpegDecoder } from './encodings/tight.ts'
import { protocolError, RfbError } from './errors.ts'
import { zlibBound } from './inflator.ts'
import type { Screen } from './messages.ts'
import * as msg from './messages.ts'
import {
  type Color,
  type PixelFormat,
  type PixelFormatName,
  pixelFormats,
  readPixelFormat,
  validatePixelFormat,
} from './pixel-format.ts'
import type { CursorRect, LedStateRect, Rect, Update } from './rect.ts'
import { noneAuth, vncAuth } from './security/basic.ts'
import { ardAuth, msLogonIIAuth } from './security/dh.ts'
import { rsaAesAuth } from './security/rsa-aes.ts'
import { readCapabilities, type TightCapability, tightAuth } from './security/tight.ts'
import {
  type CredentialName,
  type Credentials,
  type ProtocolVersion,
  type SecurityContext,
  type SecurityHandler,
  type SecurityOutcome,
  securityName,
} from './security/types.ts'
import { vencryptAuth } from './security/vencrypt.ts'
import { Transport } from './transport.ts'

export type { Credentials, ProtocolVersion }

/** Asked for the credentials a security type needs that weren't given as options. */
export type CredentialsProvider = (request: {
  securityType: number
  needs: CredentialName[]
}) => Credentials | Promise<Credentials>

export interface ConnectOptions {
  /** Default `127.0.0.1`. */
  host?: string
  /** Default 5900. */
  port?: number
  /** A Unix socket instead of `host` and `port`. */
  path?: string
  /** An open duplex stream to talk RFB over (a proxy, a WebSocket stream, a reverse connection) instead. */
  stream?: Duplex
  password?: string
  /** For security types that log in a user: Apple Remote Desktop, VeNCrypt Plain, RSA-AES, MS Logon II. */
  username?: string
  /** Called for credentials not given as `username` / `password`. */
  credentials?: CredentialsProvider
  /** @deprecated The 0.x callback form of `credentials` (password only); called with the client as `this`. */
  credentialsCallback?: (this: RfbClient, done: (password: string) => void) => void
  /**
   * Security types to accept, most preferred first (`security.*`; VeNCrypt subtypes such as
   * `security.X509Vnc` select VeNCrypt). Default: every supported type, ordered by the credentials given.
   */
  security?: readonly number[]
  /** TLS options for the VeNCrypt X509 subtypes (e.g. `ca`, `servername`, `rejectUnauthorized`). */
  tls?: tls.ConnectionOptions
  /** Encodings and pseudo-encodings to offer, most preferred first. Default: `defaultEncodings`. */
  encodings?: readonly number[]
  /**
   * The pixel format rects are decoded to: a `pixelFormats` name, a PixelFormat, or `'server'` to
   * keep the server's own. Default `'bgrx'` (32-bit little-endian 0x00RRGGBB).
   */
  pixelFormat?: PixelFormat | PixelFormatName | 'server'
  /** Leave other clients connected (default true). */
  shared?: boolean
  /** Connecting through an UltraVNC repeater: the ID to send, e.g. `'ID:1234'`. */
  repeaterId?: string
  /** Fail with TIMEOUT if the handshake hasn't finished within this many ms. */
  timeout?: number
  /** Aborting closes the connection at once (during the handshake: fails with ABORTED). */
  signal?: AbortSignal
  /** Ask for the whole screen as soon as connected (default true). */
  initialUpdate?: boolean
  /** Ask for the next incremental update after each update (default false). */
  autoUpdate?: boolean
  /** Decodes Tight JPEG rects to pixels; without it they arrive as `{ type: 'jpeg' }` rects. */
  decodeJpeg?: JpegDecoder
  /** Highest protocol version to agree to (default 3.8). */
  maxVersion?: ProtocolVersion
  /**
   * The longest clipboard text taken from the server, in bytes (default 10 MiB). Longer text is
   * dropped, and a `warning` event says so; it is never buffered or inflated past this. With the
   * Extended Clipboard it is also the size the client announces it takes unasked.
   */
  maxClipboardBytes?: number
}

/** Encodings offered by default: every lossless encoding (best first) and the pseudo-encodings that change nothing unasked. */
export const defaultEncodings: readonly number[] = [
  E.zrle,
  E.tight,
  E.trle,
  E.hextile,
  E.zlib,
  E.coRre,
  E.rre,
  E.copyRect,
  E.raw,
  E.pseudoDesktopSize,
  E.pseudoExtendedDesktopSize,
  E.pseudoLastRect,
  E.pseudoDesktopName,
  E.pseudoFence,
  E.pseudoContinuousUpdates,
  E.pseudoExtendedClipboard,
  E.pseudoQemuExtendedKeyEvent,
  E.pseudoQemuAudio,
  E.pseudoQemuLedState,
  E.pseudoVMwareLedState,
  E.pseudoExtendedMouseButtons,
  E.pseudoXvp,
]

/** What the server has confirmed it supports (each becomes true when the server says so). */
export interface ServerSupport {
  continuousUpdates: boolean
  fence: boolean
  extendedDesktopSize: boolean
  extendedClipboard: boolean
  /**
   * `updateClipboard` sends text of any length as UTF-8: the server's Extended Clipboard takes text and
   * the notify action. When false, text may go as Latin-1, with '?' for other characters.
   */
  unicodeClipboard: boolean
  qemuExtendedKeyEvent: boolean
  qemuAudio: boolean
  extendedMouseButtons: boolean
  /** The xvp extension version, 0 when unsupported. */
  xvp: number
}

/** The interaction capabilities a server sends after ServerInit with the Tight security type. */
export interface TightInteraction {
  serverMessages: TightCapability[]
  clientMessages: TightCapability[]
  encodings: TightCapability[]
}

export type AudioEvent = { type: 'start' } | { type: 'stop' } | { type: 'data'; data: Buffer }

export type RfbClientEvents = {
  /** The handshake is done: `width`, `height`, `name` and `pixelFormat` are set. */
  connect: []
  /** One rect of an update, decoded (also pseudo-rects: cursor, desktop size, ...). */
  rect: [rect: Rect]
  /** A whole FramebufferUpdate, after its rects. */
  update: [update: Update]
  /** The framebuffer size changed (DesktopSize / ExtendedDesktopSize). */
  resize: [size: { width: number; height: number; screens: Screen[] }]
  cursor: [cursor: CursorRect]
  cursorPosition: [position: { x: number; y: number }]
  desktopName: [name: string]
  ledState: [state: Pick<LedStateRect, 'scrollLock' | 'numLock' | 'capsLock'>]
  colormap: [change: { firstColor: number; colors: Color[] }]
  bell: []
  /** The server's clipboard (Latin-1 text, or UTF-8 with the Extended Clipboard). */
  clipboard: [text: string]
  /**
   * Extended Clipboard: the server's clipboard changed and holds no text (it was emptied, or holds
   * only other formats, such as an image).
   */
  clipboardEmpty: []
  /** A ServerFence that answers ours (requests from the server are answered automatically). */
  fence: [fence: { flags: number; payload: Buffer }]
  xvp: [message: { version: number; code: number }]
  endOfContinuousUpdates: []
  audio: [event: AudioEvent]
  /** A problem the connection survived: clipboard text over `maxClipboardBytes` was dropped (`CLIPBOARD_TOO_LARGE`). */
  warning: [warning: RfbError]
  error: [error: RfbError]
  /** The connection is closed; `hadError` when an `error` event came first. */
  close: [hadError: boolean]
}

const CLIP = {
  text: 1,
  caps: 1 << 24,
  request: 1 << 25,
  peek: 1 << 26,
  notify: 1 << 27,
  provide: 1 << 28,
} as const
/** The default `maxClipboardBytes`. */
const CLIPBOARD_LIMIT = 10 * 1024 * 1024

const handlers: Record<number, SecurityHandler> = {
  [S.None]: noneAuth,
  [S.VNC]: (ctx) => vncAuth(ctx),
  [S.Tight]: tightAuth,
  [S.VeNCrypt]: vencryptAuth,
  [S.ARD]: ardAuth,
  [S.MSLogonII]: msLogonIIAuth,
  [S.RA2]: rsaAesAuth,
  [S.RA2ne]: rsaAesAuth,
  [S.RA2_256]: rsaAesAuth,
  [S.RA2ne_256]: rsaAesAuth,
}

/** Every security type this client can do, by preference, given which credentials it has. */
export function defaultSecurity(hasUsername: boolean): number[] {
  const none = [S.None, S.TLSNone, S.X509None]
  const password = [S.VNC, S.TLSVnc, S.X509Vnc]
  const user = [S.ARD, S.X509Plain, S.TLSPlain, S.Plain, S.MSLogonII]
  const rsa = [S.RA2_256, S.RA2, S.RA2ne_256, S.RA2ne]
  return hasUsername
    ? [...none, ...user, ...rsa, ...password, S.Tight]
    : [...none, ...password, ...rsa, ...user, S.Tight]
}

type State = 'connecting' | 'connected' | 'closing' | 'closed'

/**
 * An RFB (VNC) client connection. Construct it (or use `connect()`), wait for `connect`, then
 * listen for `rect` / `update` and send input. Errors arrive as `error` events (RfbError).
 */
export class RfbClient extends EventEmitter<RfbClientEvents> {
  /** Framebuffer size. */
  width = 0
  height = 0
  /** Desktop name. */
  name = ''
  /** The server's version string as sent, e.g. `'RFB 003.008\n'`. */
  serverVersion = ''
  /** The protocol version in use. */
  protocolVersion: ProtocolVersion = '3.8'
  securityType = 0
  /** The format rects are decoded in. */
  pixelFormat: PixelFormat = pixelFormats.bgrx
  /** The server's native format (ServerInit). */
  serverPixelFormat: PixelFormat = pixelFormats.bgrx
  /** Colour map entries (colour-map pixel formats), 16 bits per channel. */
  colorMap: (Color | undefined)[] = []
  /** The screen layout (ExtendedDesktopSize). */
  screens: Screen[] = []
  /** The latest cursor shape, when a cursor pseudo-encoding is enabled. */
  cursor: CursorRect | null = null
  /** QEMU pointer motion mode: in `relative` mode PointerEvent carries deltas. */
  pointerMode: 'absolute' | 'relative' = 'absolute'
  /** What the server confirmed it supports. */
  readonly supports: ServerSupport = {
    continuousUpdates: false,
    fence: false,
    extendedDesktopSize: false,
    extendedClipboard: false,
    unicodeClipboard: false,
    qemuExtendedKeyEvent: false,
    qemuAudio: false,
    extendedMouseButtons: false,
    xvp: 0,
  }
  /** With the Tight security type: the server's interaction capabilities. */
  tightCapabilities: TightInteraction | null = null
  /** Ask for the next incremental update after each update. */
  autoUpdate: boolean

  readonly #options: ConnectOptions
  readonly #decoder: Decoder
  #encodings: number[]
  #transport: Transport | null = null
  #pendingAbort: RfbError | null = null
  #state: State = 'connecting'
  #closeError: RfbError | null = null
  #timer: NodeJS.Timeout | undefined
  #continuous = false
  #updateWaiters: { resolve: (u: Update) => void; reject: (e: Error) => void }[] = []
  #resizeWaiters: { resolve: () => void; reject: (e: Error) => void }[] = []
  #closeWaiters: (() => void)[] = []
  #clipboard = {
    serverFlags: 0,
    textLimit: 0,
    /** The client's text, while it holds the clipboard. */
    text: null as string | null,
    /** The server may hold text of its own (assumed until it says otherwise: TigerVNC doesn't tell new clients). */
    serverText: true,
    /** A notify without text is due: the server reporting that the client's change took its text away. */
    echo: false,
  }
  readonly #maxClipboard: number
  #onAbort = () => {
    if (this.#state === 'connecting') this.#abort(new RfbError('ABORTED', 'the connection was aborted'))
    else this.destroy()
  }

  constructor(options: ConnectOptions = {}) {
    super()
    this.#options = options
    this.autoUpdate = options.autoUpdate ?? false
    this.#encodings = checkEncodings(options.encodings ?? defaultEncodings)
    const pf = options.pixelFormat
    if (pf !== undefined && pf !== 'server') {
      if (typeof pf === 'string' && !(pf in pixelFormats)) {
        throw new RfbError(
          'INVALID_ARGUMENT',
          `unknown pixel format '${pf}'; use one of ${Object.keys(pixelFormats).join(', ')}`,
        )
      }
      validatePixelFormat(typeof pf === 'string' ? pixelFormats[pf] : pf)
    }
    const maxClipboard = options.maxClipboardBytes ?? CLIPBOARD_LIMIT
    // Text up to this many bytes still fits in a JavaScript string.
    const longest = buffer.constants.MAX_STRING_LENGTH
    if (!Number.isSafeInteger(maxClipboard) || maxClipboard < 0 || maxClipboard > longest) {
      throw new RfbError('INVALID_ARGUMENT', `maxClipboardBytes must be a whole number of bytes from 0 to ${longest}`)
    }
    this.#maxClipboard = maxClipboard
    this.#decoder = new Decoder({ decodeJpeg: options.decodeJpeg })
    options.signal?.addEventListener('abort', this.#onAbort, { once: true })
    void this.#run()
  }

  /** @deprecated 0.x name of `name`. */
  get title(): string {
    return this.name
  }

  /** The underlying stream (a TLSSocket after a VeNCrypt TLS upgrade). */
  get stream(): Duplex | undefined {
    return this.#transport?.stream
  }

  /** True once the handshake is done and until the connection closes. */
  get connected(): boolean {
    return this.#state === 'connected'
  }

  get closed(): boolean {
    return this.#state === 'closed'
  }

  /** The encodings offered to the server. */
  get encodings(): readonly number[] {
    return this.#encodings
  }

  // 0.x exposed the pixel format as fields on the client.
  /** @deprecated use `pixelFormat.bitsPerPixel` */
  get bpp(): number {
    return this.pixelFormat.bitsPerPixel
  }
  /** @deprecated use `pixelFormat.depth` */
  get depth(): number {
    return this.pixelFormat.depth
  }
  /** @deprecated use `pixelFormat.bigEndian` */
  get isBigEndian(): number {
    return this.pixelFormat.bigEndian ? 1 : 0
  }
  /** @deprecated use `pixelFormat.trueColor` */
  get isTrueColor(): number {
    return this.pixelFormat.trueColor ? 1 : 0
  }
  /** @deprecated use `pixelFormat.redMax` */
  get redMax(): number {
    return this.pixelFormat.redMax
  }
  /** @deprecated use `pixelFormat.greenMax` */
  get greenMax(): number {
    return this.pixelFormat.greenMax
  }
  /** @deprecated use `pixelFormat.blueMax` */
  get blueMax(): number {
    return this.pixelFormat.blueMax
  }
  /** @deprecated use `pixelFormat.redShift` */
  get redShift(): number {
    return this.pixelFormat.redShift
  }
  /** @deprecated use `pixelFormat.greenShift` */
  get greenShift(): number {
    return this.pixelFormat.greenShift
  }
  /** @deprecated use `pixelFormat.blueShift` */
  get blueShift(): number {
    return this.pixelFormat.blueShift
  }

  // --- input and requests ---

  /**
   * FramebufferUpdateRequest. Defaults: incremental, the whole screen. A non-incremental request
   * asks for every pixel of the area again.
   */
  requestUpdate(
    incremental: boolean | number = true,
    x = 0,
    y = 0,
    width = this.width - x,
    height = this.height - y,
  ): void {
    this.#send(msg.framebufferUpdateRequest(Boolean(incremental), x, y, width, height))
  }

  /** PointerEvent: the pointer is at `x`, `y` with `buttons` (a `buttons.*` mask) held. */
  pointerEvent(x: number, y: number, buttons = 0): void {
    this.#send(msg.pointerEvent(buttons, x, y, this.supports.extendedMouseButtons))
  }

  /** KeyEvent for an X11 keysym (`keysyms.*`, or the code point for Latin-1 characters). */
  keyEvent(keysym: number, down: boolean | number = true): void {
    this.#send(msg.keyEvent(Boolean(down), keysym))
  }

  /**
   * A key event with its XT scancode as well (QEMU extended key event), so the server needs no
   * keymap. Falls back to `keyEvent` when the server hasn't confirmed the extension.
   */
  qemuKeyEvent(keysym: number, keycode: number, down: boolean | number = true): void {
    if (this.supports.qemuExtendedKeyEvent) this.#send(msg.qemuExtendedKeyEvent(Boolean(down), keysym, keycode))
    else this.keyEvent(keysym, down)
  }

  /**
   * Sets the server's clipboard. When `supports.unicodeClipboard` the text goes as UTF-8; otherwise as
   * Latin-1 (other characters become '?'). With the Extended Clipboard the client then hands the text
   * to the server on request, until the server reports a newer clipboard of its own.
   */
  updateClipboard(text: string): void {
    if (!this.supports.extendedClipboard) {
      this.#send(msg.clientCutText(text))
      return
    }
    const c = this.#clipboard
    c.text = text
    // When the client's text replaces text of the server's own, TigerVNC and TurboVNC tell every client,
    // this one included, that the server's text is gone (a notify without text): no change for this one.
    if (c.serverText) c.echo = true
    c.serverText = false
    const flags = c.serverFlags
    if (flags & CLIP.provide && Buffer.byteLength(text) + 1 <= c.textLimit) this.#provideClipboard()
    else if (flags & CLIP.text && flags & CLIP.notify) this.#sendClipboard(CLIP.notify | CLIP.text)
    else this.#send(msg.clientCutText(text))
  }

  /** Changes the encodings offered (preference order). */
  setEncodings(list: readonly number[]): void {
    this.#encodings = checkEncodings(list)
    this.#send(msg.setEncodings(this.#encodings))
  }

  /**
   * Continuous updates (the server sends updates for the area without requests). Needs
   * `supports.continuousUpdates`. Disabling is confirmed by `endOfContinuousUpdates`.
   */
  enableContinuousUpdates(enable = true, x = 0, y = 0, width = this.width - x, height = this.height - y): void {
    this.#require(this.supports.continuousUpdates, 'continuous updates', 'pseudoContinuousUpdates')
    this.#continuous = enable
    this.#send(msg.enableContinuousUpdates(enable, x, y, width, height))
  }

  /** ClientFence (needs `supports.fence`): the answer arrives as a `fence` event. */
  fence(flags: number, payload: Uint8Array = Buffer.alloc(0)): void {
    this.#require(this.supports.fence, 'fences', 'pseudoFence')
    this.#send(msg.clientFence((flags | fenceFlags.request) >>> 0, payload))
  }

  /** xvp: ask the server to shut down, reboot or reset the machine (needs `supports.xvp`). */
  xvp(operation: 'shutdown' | 'reboot' | 'reset'): void {
    this.#require(this.supports.xvp > 0, 'xvp', 'pseudoXvp')
    this.#send(msg.xvp(1, xvpCodes[operation]))
  }

  /**
   * SetDesktopSize (needs `supports.extendedDesktopSize`). Resolves when the server confirms,
   * rejects with SERVER_REFUSED when it refuses. Default layout: one screen covering the framebuffer.
   */
  setDesktopSize(width: number, height: number, screens?: readonly Screen[]): Promise<void> {
    this.#require(this.supports.extendedDesktopSize, 'desktop resizing', 'pseudoExtendedDesktopSize')
    const layout = screens ?? [
      { id: this.screens[0]?.id ?? 0, flags: this.screens[0]?.flags ?? 0, x: 0, y: 0, width, height },
    ]
    this.#send(msg.setDesktopSize(width, height, layout))
    return new Promise((resolve, reject) => this.#resizeWaiters.push({ resolve, reject }))
  }

  /** QEMU audio capture: sets the sample format and starts it (needs `supports.qemuAudio`). */
  enableAudio(format: { sampleFormat?: number; channels?: 1 | 2; frequency?: number } = {}): void {
    this.#require(this.supports.qemuAudio, 'QEMU audio', 'pseudoQemuAudio')
    this.#send(
      msg.qemuAudioSetFormat(format.sampleFormat ?? audioFormats.s16, format.channels ?? 2, format.frequency ?? 44100),
    )
    this.#send(msg.qemuAudio(0))
  }

  disableAudio(): void {
    this.#require(this.supports.qemuAudio, 'QEMU audio', 'pseudoQemuAudio')
    this.#send(msg.qemuAudio(1))
  }

  /** The next FramebufferUpdate (doesn't request one). */
  nextUpdate(): Promise<Update> {
    if (this.#state === 'closed') return Promise.reject(this.#closedError())
    return new Promise((resolve, reject) => this.#updateWaiters.push({ resolve, reject }))
  }

  /**
   * Updates as an async iterator with back-pressure: the next update is requested only when the
   * previous one has been taken. The first request is non-incremental unless `incremental` is set.
   * Ends when the connection closes (throws if it closed with an error).
   */
  async *updates(options: { incremental?: boolean } = {}): AsyncGenerator<Update, void, undefined> {
    const queue: Update[] = []
    const onUpdate = (u: Update) => queue.push(u)
    this.on('update', onUpdate)
    let incremental = options.incremental ?? false
    try {
      for (;;) {
        if (queue.length === 0) {
          if (this.#state === 'closed') break
          // With continuous updates on, the server sends updates unasked.
          if (!this.#continuous || !incremental) this.requestUpdate(incremental)
          incremental = true
          try {
            await this.nextUpdate()
          } catch (err) {
            if (this.closed && this.#closeError === null) break
            throw err
          }
        }
        const next = queue.shift()
        if (next) yield next
      }
    } finally {
      this.off('update', onUpdate)
    }
  }

  // --- closing ---

  /** Closes the connection gracefully (0.x API; see `close()`). */
  end(): void {
    if (this.#state === 'closed' || this.#state === 'closing') return
    if (this.#state === 'connecting') {
      this.#abort(new RfbError('ABORTED', 'the connection was closed before the handshake finished'))
      return
    }
    this.#state = 'closing'
    this.#transport?.end()
    // Don't wait for a server that never closes its side.
    setTimeout(() => this.#transport?.destroy(), 2000).unref()
  }

  /** Closes the connection; resolves once it is closed. */
  close(): Promise<void> {
    if (this.#state === 'closed') return Promise.resolve()
    const closed = new Promise<void>((resolve) => this.#closeWaiters.push(resolve))
    this.end()
    return closed
  }

  /** Closes the connection at once. */
  destroy(): void {
    if (this.#state === 'closed') return
    if (this.#state === 'connected') this.#state = 'closing'
    this.#transport?.destroy()
  }

  // --- internals ---

  #send(data: Buffer): boolean {
    if (this.#state !== 'connected' || !this.#transport) return false
    return this.#transport.write(data)
  }

  #require(supported: boolean, what: string, encoding: keyof typeof E): void {
    if (!supported) {
      throw new RfbError(
        'UNSUPPORTED_BY_SERVER',
        `the server hasn't confirmed ${what}; offer encodings.${encoding} and check client.supports first`,
      )
    }
  }

  #closedError(): RfbError {
    return this.#closeError ?? new RfbError('CONNECTION_CLOSED', 'the connection is closed')
  }

  #abort(err: RfbError): void {
    if (!this.#transport) {
      this.#pendingAbort = err
      return
    }
    this.#transport.reader.destroy(err)
    this.#transport.destroy()
  }

  async #run(): Promise<void> {
    try {
      const transport = this.#open()
      this.#transport = transport
      if (this.#pendingAbort) throw this.#pendingAbort
      if (this.#options.signal?.aborted) throw new RfbError('ABORTED', 'the connection was aborted')
      if (this.#options.timeout !== undefined) {
        const ms = this.#options.timeout
        this.#timer = setTimeout(
          () => this.#abort(new RfbError('TIMEOUT', `the RFB handshake did not finish within ${ms} ms`)),
          ms,
        )
      }
      await this.#handshake(transport)
      clearTimeout(this.#timer)
      if (this.#state !== 'connecting') return
      this.#state = 'connected'
      if (this.#options.initialUpdate !== false) this.requestUpdate(false)
      this.emit('connect')
      await this.#messageLoop(transport)
      this.#finish(null)
    } catch (err) {
      this.#finish(err)
    }
  }

  #open(): Transport {
    const o = this.#options
    if (o.stream) return new Transport(o.stream, true)
    const socket =
      o.path !== undefined
        ? net.connect({ path: o.path })
        : net.connect({ host: o.host ?? '127.0.0.1', port: o.port ?? 5900 })
    socket.setNoDelay(true)
    return new Transport(socket, false)
  }

  #finish(err: unknown): void {
    if (this.#state === 'closed') return
    const userClosing = this.#state === 'closing'
    this.#state = 'closed'
    clearTimeout(this.#timer)
    this.#options.signal?.removeEventListener('abort', this.#onAbort)
    this.#transport?.destroy()
    this.#decoder.close()
    let error: RfbError | null = null
    if (err !== null) {
      error =
        err instanceof RfbError
          ? err
          : new RfbError('PROTOCOL_ERROR', `unexpected failure: ${(err as Error)?.message ?? err}`, { cause: err })
      if (userClosing && error.code === 'CONNECTION_CLOSED') error = null
    }
    this.#closeError = error
    const reason = this.#closedError()
    for (const w of this.#updateWaiters.splice(0)) w.reject(reason)
    for (const w of this.#resizeWaiters.splice(0)) w.reject(reason)
    try {
      if (error) this.emit('error', error)
    } finally {
      this.emit('close', error !== null)
      for (const resolve of this.#closeWaiters.splice(0)) resolve()
    }
  }

  // --- handshake ---

  async #handshake(t: Transport): Promise<void> {
    const r = t.reader
    await this.#negotiateVersion(t)
    const outcome = await this.#negotiateSecurity(t)

    t.write(Buffer.from([this.#options.shared === false ? 0 : 1]))
    const init = await r.read(24)
    this.width = init.readUInt16BE(0)
    this.height = init.readUInt16BE(2)
    this.serverPixelFormat = readPixelFormat(init, 4)
    validatePixelFormat(this.serverPixelFormat, true)
    const nameLength = init.readUInt32BE(20)
    if (nameLength > 1 << 16) throw protocolError(`a ${nameLength}-byte desktop name`)
    this.name = await r.string(nameLength, 'utf8')
    if (outcome.tight) {
      const counts = await r.read(8)
      this.tightCapabilities = {
        serverMessages: await readCapabilities(r, counts.readUInt16BE(0)),
        clientMessages: await readCapabilities(r, counts.readUInt16BE(2)),
        encodings: await readCapabilities(r, counts.readUInt16BE(4)),
      }
      if (this.tightCapabilities.clientMessages.some((c) => c.code === 150)) this.supports.continuousUpdates = true
    }

    const pf = this.#options.pixelFormat ?? 'bgrx'
    if (pf === 'server') {
      this.pixelFormat = this.serverPixelFormat
    } else {
      this.pixelFormat = typeof pf === 'string' ? pixelFormats[pf] : pf
      t.write(msg.setPixelFormat(this.pixelFormat))
    }
    t.write(msg.setEncodings(this.#encodings))
  }

  async #negotiateVersion(t: Transport): Promise<void> {
    const r = t.reader
    let banner = await r.string(12, 'latin1')
    let m = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner)
    if (m && m[1] === '000' && m[2] === '000') {
      // An UltraVNC repeater: it wants the ID, then the server's version string follows.
      const id = this.#options.repeaterId
      if (id === undefined) {
        throw new RfbError('INVALID_ARGUMENT', 'this is an UltraVNC repeater; pass `repeaterId` (e.g. "ID:1234")')
      }
      const buf = Buffer.alloc(250)
      buf.write(id, 'latin1')
      t.write(buf)
      banner = await r.string(12, 'latin1')
      m = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner)
    }
    if (!m) {
      throw new RfbError(
        'NOT_RFB',
        `the server sent ${JSON.stringify(banner)} instead of an RFB version; is this a VNC server port?`,
      )
    }
    this.serverVersion = banner
    const major = Number(m[1])
    const minor = Number(m[2])
    let version: ProtocolVersion
    if (major > 3 || (major === 3 && minor >= 8)) version = '3.8'
    else if (major === 3 && minor === 7) version = '3.7'
    else if (major === 3 && minor >= 3) version = '3.3'
    else
      throw new RfbError(
        'UNSUPPORTED_VERSION',
        `the server speaks RFB ${major}.${minor}; this client needs 3.3 or later`,
      )
    const max = this.#options.maxVersion
    if (max !== undefined && version > max) version = max
    this.protocolVersion = version
    t.write(Buffer.from(`RFB 003.00${version[2]}\n`, 'latin1'))
  }

  async #negotiateSecurity(t: Transport): Promise<SecurityOutcome> {
    const r = t.reader
    const preference = this.#options.security ?? defaultSecurity(this.#options.username !== undefined)
    let type: number
    if (this.protocolVersion === '3.3') {
      type = await r.u32()
      if (type === 0) throw await this.#refusal(t)
      if (!handlers[type]) {
        throw new RfbError(
          'UNSUPPORTED_SECURITY',
          `the server requires ${securityName(type)}, which this client can't do`,
        )
      }
    } else {
      const count = await r.u8()
      if (count === 0) throw await this.#refusal(t)
      const offered = [...(await r.read(count))]
      const chosen = preference.map((p) => (p >= 256 ? S.VeNCrypt : p)).find((p) => offered.includes(p) && handlers[p])
      if (chosen === undefined) {
        throw new RfbError(
          'UNSUPPORTED_SECURITY',
          `the server offers ${offered.map(securityName).join(', ')}; this client accepts ` +
            `${preference.map(securityName).join(', ')}${this.#options.security ? ' (the `security` option)' : ''}`,
        )
      }
      type = chosen
      t.write(Buffer.from([type]))
    }
    this.securityType = type
    const outcome = (await (handlers[type] as SecurityHandler)(this.#securityContext(t, preference), type)) ?? {}
    if (!outcome.skipResult) await this.#securityResult(t)
    return outcome
  }

  #securityContext(t: Transport, preference: readonly number[]): SecurityContext {
    const o = this.#options
    return {
      reader: t.reader,
      write: (data) => {
        t.write(data)
      },
      version: this.protocolVersion,
      preference,
      credentials: (type, needs) => this.#credentials(type, needs),
      tlsOptions: (anonymous) => {
        if (anonymous) {
          // TLS* subtypes: anonymous Diffie-Hellman, no certificate (TLS 1.3 has no anonymous suites).
          return { ciphers: 'aNULL:!eNULL@SECLEVEL=0', maxVersion: 'TLSv1.2', rejectUnauthorized: false }
        }
        const host = o.host ?? '127.0.0.1'
        return { ...(net.isIP(host) ? {} : { servername: host }), ...o.tls }
      },
      startTls: (options) => t.startTls(options),
      setCipher: (cipher) => t.setCipher(cipher),
    }
  }

  async #credentials(type: number, needs: readonly CredentialName[]): Promise<Credentials> {
    const o = this.#options
    const got: Credentials = {}
    if (o.username !== undefined) got.username = o.username
    if (o.password !== undefined) got.password = o.password
    let missing = needs.filter((n) => got[n] === undefined)
    if (missing.length > 0 && o.credentials) {
      Object.assign(got, await o.credentials({ securityType: type, needs: missing }))
    } else if (missing.length === 1 && missing[0] === 'password' && o.credentialsCallback) {
      const callback = o.credentialsCallback
      got.password = await new Promise<string>((resolve) => callback.call(this, resolve))
    }
    missing = needs.filter((n) => got[n] === undefined)
    if (missing.length > 0) {
      throw new RfbError(
        'AUTH_REQUIRED',
        `the server wants a ${missing.join(' and a ')} (${securityName(type)}); pass \`${missing.join('` and `')}\` or \`credentials\``,
      )
    }
    return got
  }

  async #refusal(t: Transport): Promise<RfbError> {
    const reason = await t.reader.lengthPrefixedString('utf8', 1 << 16).catch(() => undefined)
    return new RfbError('SERVER_REFUSED', `the server refused the connection${reason ? `: ${reason}` : ''}`, {
      ...(reason !== undefined && { reason }),
    })
  }

  async #securityResult(t: Transport): Promise<void> {
    let status: number
    try {
      status = await t.reader.u32()
    } catch (err) {
      // 3.3 and 3.7 servers just close the connection on failure.
      if (err instanceof RfbError && err.code === 'CONNECTION_CLOSED') {
        throw new RfbError(
          'AUTH_FAILED',
          `authentication failed (${securityName(this.securityType)}); check the credentials`,
        )
      }
      throw err
    }
    if (status === 0) return
    let reason: string | undefined
    if (this.protocolVersion === '3.8')
      reason = await t.reader.lengthPrefixedString('utf8', 1 << 16).catch(() => undefined)
    const tooMany = status === 2 ? ' (too many attempts)' : ''
    throw new RfbError(
      'AUTH_FAILED',
      `authentication failed${tooMany}${reason ? `: ${reason}` : ''} (${securityName(this.securityType)}); check the credentials`,
      { ...(reason !== undefined && { reason }) },
    )
  }

  // --- messages from the server ---

  async #messageLoop(t: Transport): Promise<void> {
    const r = t.reader
    for (;;) {
      let type: number
      try {
        type = await r.u8()
      } catch (err) {
        // Closed between messages: a clean close, not an error.
        if (err instanceof RfbError && err.code === 'CONNECTION_CLOSED' && r.available === 0) return
        throw err
      }
      switch (type) {
        case serverMsgTypes.fbUpdate:
          await this.#readUpdate(t)
          break
        case serverMsgTypes.setColorMap:
          await this.#readColorMap(t)
          break
        case serverMsgTypes.bell:
          this.emit('bell')
          break
        case serverMsgTypes.cutText:
          await this.#readCutText(t)
          break
        case serverMsgTypes.endOfContinuousUpdates:
          this.supports.continuousUpdates = true
          this.#continuous = false
          this.emit('endOfContinuousUpdates')
          break
        case serverMsgTypes.fence:
          await this.#readFence(t)
          break
        case serverMsgTypes.xvp: {
          const [, version, code] = await r.read(3)
          if (code === xvpCodes.init) this.supports.xvp = version as number
          this.emit('xvp', { version: version as number, code: code as number })
          break
        }
        case serverMsgTypes.qemu:
          await this.#readQemu(t)
          break
        default:
          throw new RfbError(
            'UNSUPPORTED_MESSAGE',
            `the server sent message type ${type}, which this client doesn't know (it never asked for it)`,
          )
      }
    }
  }

  async #readUpdate(t: Transport): Promise<void> {
    const r = t.reader
    const count = (await r.read(3)).readUInt16BE(1)
    const rects: Rect[] = []
    for (let i = 0; i < count; i++) {
      const h = await r.read(12)
      const header = {
        x: h.readUInt16BE(0),
        y: h.readUInt16BE(2),
        width: h.readUInt16BE(4),
        height: h.readUInt16BE(6),
        encoding: h.readInt32BE(8),
      }
      if (header.encoding === E.pseudoLastRect) break
      if (pixelEncodings.has(header.encoding)) this.#checkBounds(header)
      const rect = await this.#decoder.decode(r, header, this.pixelFormat, this.colorMap)
      if (rect.type === 'copy') this.#checkBounds({ ...rect, ...rect.src })
      this.#apply(rect)
      rects.push(rect)
      this.emit('rect', rect)
    }
    const update: Update = { rects }
    this.emit('update', update)
    for (const w of this.#updateWaiters.splice(0)) w.resolve(update)
    if (this.autoUpdate && this.#state === 'connected') this.requestUpdate(true)
  }

  #checkBounds(r: { x: number; y: number; width: number; height: number }): void {
    if (r.x + r.width > this.width || r.y + r.height > this.height) {
      throw protocolError(
        `a ${r.width}×${r.height} rect at ${r.x},${r.y} is outside the ${this.width}×${this.height} framebuffer`,
      )
    }
  }

  /** Client state from pseudo-rects. */
  #apply(rect: Rect): void {
    switch (rect.type) {
      case 'desktopSize':
        this.#resize(rect.width, rect.height, this.screens)
        break
      case 'extendedDesktopSize':
        this.supports.extendedDesktopSize = true
        if (rect.reason === 1) {
          const waiter = this.#resizeWaiters.shift()
          if (rect.status !== 0) {
            waiter?.reject(
              new RfbError('SERVER_REFUSED', `the server refused the new desktop size: ${resizeStatus(rect.status)}`),
            )
            return
          }
          waiter?.resolve()
        }
        this.#resize(rect.width, rect.height, rect.screens)
        break
      case 'desktopName':
        this.name = rect.name
        this.emit('desktopName', rect.name)
        break
      case 'cursor':
        this.cursor = rect
        this.emit('cursor', rect)
        break
      case 'cursorPosition':
        this.emit('cursorPosition', { x: rect.x, y: rect.y })
        break
      case 'ledState':
        this.emit('ledState', { scrollLock: rect.scrollLock, numLock: rect.numLock, capsLock: rect.capsLock })
        break
      case 'pointerMotion':
        this.pointerMode = rect.absolute ? 'absolute' : 'relative'
        break
      case 'capability':
        if (rect.encoding === E.pseudoQemuExtendedKeyEvent) this.supports.qemuExtendedKeyEvent = true
        else if (rect.encoding === E.pseudoQemuAudio) this.supports.qemuAudio = true
        else if (rect.encoding === E.pseudoExtendedMouseButtons) this.supports.extendedMouseButtons = true
        break
    }
  }

  #resize(width: number, height: number, screens: Screen[]): void {
    const changed = width !== this.width || height !== this.height
    this.screens = screens
    this.width = width
    this.height = height
    if (changed) this.emit('resize', { width, height, screens })
  }

  async #readColorMap(t: Transport): Promise<void> {
    const head = await t.reader.read(5)
    const firstColor = head.readUInt16BE(1)
    const count = head.readUInt16BE(3)
    const data = await t.reader.read(count * 6)
    const colors: Color[] = []
    for (let i = 0; i < count; i++) {
      const c = { r: data.readUInt16BE(i * 6), g: data.readUInt16BE(i * 6 + 2), b: data.readUInt16BE(i * 6 + 4) }
      colors.push(c)
      this.colorMap[firstColor + i] = c
    }
    this.emit('colormap', { firstColor, colors })
  }

  async #readCutText(t: Transport): Promise<void> {
    const r = t.reader
    const length = (await r.read(7)).readInt32BE(3)
    const max = this.#maxClipboard
    if (length >= 0) {
      // Latin-1 text, which the spec doesn't limit: past maxClipboardBytes it's dropped as it arrives.
      this.#serverOwnsClipboard(true)
      if (length > max) {
        await r.skip(length)
        this.#clipboardTooLarge(`${length} bytes`)
        return
      }
      this.emit('clipboard', (await r.read(length)).toString('latin1'))
      return
    }
    // Extended Clipboard: flags, then (provide) zlib data. The text taken inflates to at most a size
    // field and `max` bytes; a message with more zlib data than that can need is dropped unread too.
    // Only a provide carries that much, so the server has a new clipboard of its own.
    const size = -length
    if (size > 4 + zlibBound(4 + max)) {
      await r.skip(size)
      this.#serverOwnsClipboard(true)
      this.#clipboardTooLarge(`a ${size}-byte Extended Clipboard message`)
      return
    }
    this.#extendedClipboard(await r.read(size))
  }

  #clipboardTooLarge(size: string): void {
    const max = this.#maxClipboard
    this.emit(
      'warning',
      new RfbError(
        'CLIPBOARD_TOO_LARGE',
        `dropped the server's clipboard text (${size}): it is over maxClipboardBytes (${max}); raise maxClipboardBytes to receive it`,
      ),
    )
  }

  #extendedClipboard(data: Buffer): void {
    if (data.length < 4) throw protocolError('a short Extended Clipboard message')
    const flags = data.readUInt32BE(0)
    const formats = flags & 0xffff
    if (flags & CLIP.caps) {
      const sizes: number[] = []
      for (let bit = 0, o = 4; bit < 16; bit++) {
        if (formats & (1 << bit)) {
          sizes.push(o + 4 <= data.length ? data.readUInt32BE(o) : 0)
          o += 4
        }
      }
      this.#clipboard.serverFlags = flags
      this.#clipboard.textLimit = formats & CLIP.text ? (sizes[0] ?? 0) : 0
      this.supports.extendedClipboard = true
      this.supports.unicodeClipboard = (formats & CLIP.text) !== 0 && (flags & CLIP.notify) !== 0
      const caps = Buffer.alloc(8)
      caps.writeUInt32BE((CLIP.caps | CLIP.text | CLIP.request | CLIP.peek | CLIP.notify | CLIP.provide) >>> 0, 0)
      caps.writeUInt32BE(this.#maxClipboard, 4)
      this.#send(msg.clientCutTextExtended(caps))
    } else if (flags & CLIP.request) {
      if (formats & CLIP.text && this.#clipboard.text !== null) this.#provideClipboard()
    } else if (flags & CLIP.peek) {
      this.#sendClipboard(CLIP.notify | (this.#clipboard.text !== null ? CLIP.text : 0))
    } else if (flags & CLIP.notify) {
      if (formats & CLIP.text) {
        this.#serverOwnsClipboard(true)
        this.#sendClipboard(CLIP.request | CLIP.text)
      } else {
        // The server's own text is gone. The client keeps handing over its text on request (as TigerVNC's
        // viewer does), and right after the client's own change this is no change (see updateClipboard).
        const echo = this.#clipboard.echo
        this.#clipboard.echo = false
        this.#clipboard.serverText = false
        if (!echo) this.emit('clipboardEmpty')
      }
    } else if (flags & CLIP.provide) {
      // Only text is taken (the caps announce no other format). It comes first, as a U32 size and
      // that many bytes, so inflating stops after 4 + max bytes rather than decompressing all the
      // server sent: a few hundred KB of zlib data can hold gigabytes.
      if (!(formats & CLIP.text)) {
        this.#serverOwnsClipboard(false)
        this.emit('clipboardEmpty')
        return
      }
      // The server has new text, whether or not it fits: the client's own text is stale either way.
      this.#serverOwnsClipboard(true)
      const max = this.#maxClipboard
      let body: Buffer
      try {
        body = zlib.inflateSync(data.subarray(4), {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
          maxOutputLength: 4 + max,
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          this.#clipboardTooLarge(`more than ${max} bytes`)
          return
        }
        throw protocolError(`corrupt Extended Clipboard data (${(err as Error).message})`)
      }
      if (body.length < 4) return
      const size = body.readUInt32BE(0)
      if (size > max) {
        this.#clipboardTooLarge(`${size} bytes`)
        return
      }
      const value = body.subarray(4, 4 + size)
      const end = value.indexOf(0)
      this.emit('clipboard', value.toString('utf8', 0, end < 0 ? value.length : end).replace(/\r\n/g, '\n'))
    }
  }

  /** The server reports a newer clipboard of its own: the client no longer holds the clipboard. */
  #serverOwnsClipboard(withText: boolean): void {
    this.#clipboard.text = null
    this.#clipboard.echo = false
    this.#clipboard.serverText = withText
  }

  #sendClipboard(flags: number): void {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(flags >>> 0)
    this.#send(msg.clientCutTextExtended(b))
  }

  #provideClipboard(): void {
    const text = Buffer.from(`${(this.#clipboard.text ?? '').replace(/\r?\n/g, '\r\n')}\0`, 'utf8')
    const size = Buffer.alloc(4)
    size.writeUInt32BE(text.length)
    const head = Buffer.alloc(4)
    head.writeUInt32BE((CLIP.provide | CLIP.text) >>> 0)
    this.#send(msg.clientCutTextExtended(Buffer.concat([head, zlib.deflateSync(Buffer.concat([size, text]))])))
  }

  async #readFence(t: Transport): Promise<void> {
    const head = await t.reader.read(8)
    const flags = head.readUInt32BE(3)
    const length = head[7] as number
    if (length > 64) throw protocolError(`a ${length}-byte fence payload`)
    const payload = Buffer.from(await t.reader.read(length))
    this.supports.fence = true
    if (flags & fenceFlags.request) {
      // Everything is handled in order, so the block and sync flags are satisfied by answering now.
      const answer = flags & (fenceFlags.blockBefore | fenceFlags.blockAfter | fenceFlags.syncNext)
      this.#send(msg.clientFence(answer, payload))
    } else {
      this.emit('fence', { flags, payload })
    }
  }

  async #readQemu(t: Transport): Promise<void> {
    const r = t.reader
    const subtype = await r.u8()
    if (subtype !== 1) throw new RfbError('UNSUPPORTED_MESSAGE', `the server sent QEMU message subtype ${subtype}`)
    const operation = await r.u16()
    if (operation === 0) this.emit('audio', { type: 'stop' })
    else if (operation === 1) this.emit('audio', { type: 'start' })
    else if (operation === 2) {
      const length = await r.u32()
      if (length > 16 * 1024 * 1024) throw protocolError(`a ${length}-byte audio message`)
      this.emit('audio', { type: 'data', data: Buffer.from(await r.read(length)) })
    } else {
      throw protocolError(`unknown QEMU audio operation ${operation}`)
    }
  }
}

function resizeStatus(status: number): string {
  return (
    ['no error', 'resizing is prohibited', 'out of resources', 'invalid screen layout', 'request forwarded'][status] ??
    `error ${status}`
  )
}

function checkEncodings(list: readonly number[]): number[] {
  const unknown = list.filter((e) => !isKnownEncoding(e))
  if (unknown.length > 0) {
    throw new RfbError(
      'UNSUPPORTED_ENCODING',
      `this client can't decode encoding${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; use the values in \`encodings\``,
    )
  }
  return [...list]
}

/** Connects and resolves once the handshake is done (rejects with an RfbError). */
export function connect(options: ConnectOptions = {}): Promise<RfbClient> {
  return new Promise((resolve, reject) => {
    const client = new RfbClient(options)
    const onError = (err: RfbError) => {
      client.off('connect', onConnect)
      reject(err)
    }
    const onConnect = () => {
      client.off('error', onError)
      resolve(client)
    }
    client.once('error', onError)
    client.once('connect', onConnect)
  })
}

/** The 0.x entry point: returns the client at once; wait for its `connect` event. */
export function createConnection(options: ConnectOptions = {}): RfbClient {
  return new RfbClient(options)
}
