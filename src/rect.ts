import type { Screen } from './messages.ts'

/** Every rect: its place on the screen and the encoding it came in (`encodings.*`). */
export interface RectHeader {
  x: number
  y: number
  width: number
  height: number
  encoding: number
}

/**
 * Pixels for the rect, whatever the wire encoding (Raw, RRE, Hextile, Zlib, Tight, TightPNG, TRLE,
 * ZRLE): `width * height` pixels in the client's pixel format, row after row, no padding.
 */
export interface PixelsRect extends RectHeader {
  type: 'pixels'
  data: Buffer
}

/** CopyRect: copy `width`×`height` from `src` (in the framebuffer as it is now) to `x`, `y`. */
export interface CopyRect extends RectHeader {
  type: 'copy'
  src: { x: number; y: number }
}

/** A Tight JPEG rect, when no `decodeJpeg` option is set: decode `jpeg` and draw it at `x`, `y`. */
export interface JpegRect extends RectHeader {
  type: 'jpeg'
  jpeg: Buffer
}

/**
 * A new cursor shape (Cursor, XCursor, CursorWithAlpha and VMware cursor pseudo-encodings).
 * `x`, `y` is the hotspot. `rgba` is the image with straight (not premultiplied) alpha. For the
 * Cursor pseudo-encoding, `data` and `mask` are also given as sent (pixels in the client's format
 * and the 1-bit-per-pixel transparency mask). A 0×0 cursor hides the pointer.
 */
export interface CursorRect extends RectHeader {
  type: 'cursor'
  rgba: Buffer
  data?: Buffer
  mask?: Buffer
}

/** DesktopSize: the framebuffer is now `width`×`height`. */
export interface DesktopSizeRect extends RectHeader {
  type: 'desktopSize'
}

/**
 * ExtendedDesktopSize: the framebuffer is `width`×`height` with this screen layout. `reason`
 * 0: changed on the server (or the answer to a full update request), 1: answer to this client's
 * `setDesktopSize()`, 2: another client changed it. `status` 0 is success; for reason 1 non-zero
 * means the request was refused (1 prohibited, 2 out of resources, 3 invalid layout, 4 forwarded).
 */
export interface ExtendedDesktopSizeRect extends RectHeader {
  type: 'extendedDesktopSize'
  reason: number
  status: number
  screens: Screen[]
}

/** DesktopName: the desktop is now called `name`. */
export interface DesktopNameRect extends RectHeader {
  type: 'desktopName'
  name: string
}

/** The server moved the pointer to `x`, `y` (PointerPos and VMware cursor position pseudo-encodings). */
export interface CursorPositionRect extends RectHeader {
  type: 'cursorPosition'
}

/** Keyboard lock LEDs (QEMU and VMware LED state pseudo-encodings). */
export interface LedStateRect extends RectHeader {
  type: 'ledState'
  scrollLock: boolean
  numLock: boolean
  capsLock: boolean
}

/** QEMU pointer motion change: the server wants absolute (`true`) or relative (`false`) pointer events. */
export interface PointerMotionRect extends RectHeader {
  type: 'pointerMotion'
  absolute: boolean
}

/** VMware cursor state: whether the cursor is visible (bit 0), absolute (bit 1), warped (bit 2). */
export interface CursorStateRect extends RectHeader {
  type: 'cursorState'
  state: number
}

/**
 * The server confirmed an extension by sending its empty pseudo-rect: QEMU extended key events,
 * QEMU audio or extended mouse buttons (`encoding` says which).
 */
export interface CapabilityRect extends RectHeader {
  type: 'capability'
}

export type Rect =
  | PixelsRect
  | CopyRect
  | JpegRect
  | CursorRect
  | DesktopSizeRect
  | ExtendedDesktopSizeRect
  | DesktopNameRect
  | CursorPositionRect
  | LedStateRect
  | PointerMotionRect
  | CursorStateRect
  | CapabilityRect

/** One FramebufferUpdate: its rects, in order. */
export interface Update {
  rects: Rect[]
}
