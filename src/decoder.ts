import { encodings as E } from './constants.ts'
import { decodeRichCursor, decodeVMwareCursor, decodeXCursor, unpremultiply } from './encodings/cursor.ts'
import { decodeHextile } from './encodings/hextile.ts'
import { decodeRre } from './encodings/rre.ts'
import { decodeTight, type JpegDecoder } from './encodings/tight.ts'
import { decodeTrle, decodeZrle } from './encodings/trle.ts'
import { protocolError, RfbError } from './errors.ts'
import { checkZlibLength, Inflator } from './inflator.ts'
import type { Screen } from './messages.ts'
import { bytesPerPixel, type Color, type PixelFormat } from './pixel-format.ts'
import type { ByteReader } from './reader.ts'
import type { Rect, RectHeader } from './rect.ts'

/** Encodings that carry pixels. */
export const pixelEncodings: ReadonlySet<number> = new Set([
  E.raw,
  E.copyRect,
  E.rre,
  E.coRre,
  E.hextile,
  E.zlib,
  E.tight,
  E.trle,
  E.zrle,
  E.tightPng,
])

/** Pseudo-encodings this client understands (single values; see `isKnownEncoding` for the ranges). */
const pseudoEncodings: ReadonlySet<number> = new Set([
  E.pseudoDesktopSize,
  E.pseudoLastRect,
  E.pseudoPointerPos,
  E.pseudoCursor,
  E.pseudoXCursor,
  E.pseudoQemuPointerMotionChange,
  E.pseudoQemuExtendedKeyEvent,
  E.pseudoQemuAudio,
  E.pseudoQemuLedState,
  E.pseudoDesktopName,
  E.pseudoExtendedDesktopSize,
  E.pseudoXvp,
  E.pseudoFence,
  E.pseudoContinuousUpdates,
  E.pseudoCursorWithAlpha,
  E.pseudoExtendedMouseButtons,
  E.pseudoTightWithoutZlib,
  E.pseudoVMwareCursor,
  E.pseudoVMwareCursorState,
  E.pseudoVMwareCursorPosition,
  E.pseudoVMwareLedState,
  E.pseudoExtendedClipboard,
])

/** True for every encoding and pseudo-encoding this client can decode or honour. */
export function isKnownEncoding(e: number): boolean {
  return (
    pixelEncodings.has(e) ||
    pseudoEncodings.has(e) ||
    (e >= E.pseudoCompressionLevel0 && e <= E.pseudoCompressionLevel0 + 9) ||
    (e >= E.pseudoQualityLevel0 && e <= E.pseudoQualityLevel0 + 9) ||
    (e >= E.pseudoFineQualityLevel0 && e <= E.pseudoFineQualityLevel0 + 100) ||
    (e >= E.pseudoSubsampLevel0 && e <= E.pseudoSubsampLevel0 + 5)
  )
}

/** Pixel format of CursorWithAlpha data: bytes R, G, B, A (alpha in the top byte). */
const RGBA_FORMAT: PixelFormat = {
  bitsPerPixel: 32,
  depth: 32,
  bigEndian: false,
  trueColor: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 0,
  greenShift: 8,
  blueShift: 16,
}

/** Largest cursor accepted (guards allocations driven by the server). */
const MAX_CURSOR = 1024

/**
 * Per-connection decoding state (the zlib streams of Zlib, ZRLE and Tight) and the rect decoders.
 * `decode` reads one rect's data after its header.
 */
export class Decoder {
  readonly #zlib = new Inflator()
  readonly #zrle = new Inflator()
  readonly #tight = [new Inflator(), new Inflator(), new Inflator(), new Inflator()]
  readonly #decodeJpeg: JpegDecoder | undefined

  constructor(options: { decodeJpeg?: JpegDecoder | undefined } = {}) {
    this.#decodeJpeg = options.decodeJpeg
  }

  async decode(
    reader: ByteReader,
    h: RectHeader,
    pf: PixelFormat,
    colorMap: readonly (Color | undefined)[],
  ): Promise<Rect> {
    const { x, y, width: w, height: ht, encoding } = h
    switch (encoding) {
      case E.copyRect: {
        const b = await reader.read(4)
        return { type: 'copy', ...h, src: { x: b.readUInt16BE(0), y: b.readUInt16BE(2) } }
      }
      case E.pseudoDesktopSize:
        return { type: 'desktopSize', ...h }
      case E.pseudoExtendedDesktopSize: {
        const count = (await reader.read(4))[0] as number
        const body = await reader.read(16 * count)
        const screens: Screen[] = []
        for (let i = 0; i < count; i++) {
          const o = i * 16
          screens.push({
            id: body.readUInt32BE(o),
            x: body.readUInt16BE(o + 4),
            y: body.readUInt16BE(o + 6),
            width: body.readUInt16BE(o + 8),
            height: body.readUInt16BE(o + 10),
            flags: body.readUInt32BE(o + 12),
          })
        }
        return { type: 'extendedDesktopSize', ...h, reason: x, status: y, screens }
      }
      case E.pseudoDesktopName:
        return { type: 'desktopName', ...h, name: await reader.lengthPrefixedString('utf8', 1 << 16) }
      case E.pseudoCursor: {
        checkCursor(w, ht)
        return { type: 'cursor', ...h, ...(await decodeRichCursor(reader, w, ht, pf, colorMap)) }
      }
      case E.pseudoXCursor:
        checkCursor(w, ht)
        return { type: 'cursor', ...h, ...(await decodeXCursor(reader, w, ht)) }
      case E.pseudoCursorWithAlpha: {
        checkCursor(w, ht)
        const inner = await reader.s32()
        if (inner === E.copyRect || !pixelEncodings.has(inner)) {
          throw protocolError(`CursorWithAlpha: encoding ${inner} can't carry cursor pixels`)
        }
        const result = await this.#pixels(reader, inner, w, ht, RGBA_FORMAT)
        if (!('data' in result)) throw protocolError('CursorWithAlpha: a JPEG cursor')
        const rgba = Buffer.from(result.data)
        return { type: 'cursor', ...h, rgba: unpremultiply(rgba) }
      }
      case E.pseudoVMwareCursor:
        checkCursor(w, ht)
        return { type: 'cursor', ...h, ...(await decodeVMwareCursor(reader, w, ht, pf, colorMap)) }
      case E.pseudoVMwareCursorState:
        return { type: 'cursorState', ...h, state: await reader.u16() }
      case E.pseudoPointerPos:
      case E.pseudoVMwareCursorPosition:
        return { type: 'cursorPosition', ...h }
      case E.pseudoQemuLedState:
        return { type: 'ledState', ...h, ...leds(await reader.u8()) }
      case E.pseudoVMwareLedState:
        return { type: 'ledState', ...h, ...leds(await reader.u32()) }
      case E.pseudoQemuPointerMotionChange:
        return { type: 'pointerMotion', ...h, absolute: x !== 0 }
      case E.pseudoQemuExtendedKeyEvent:
      case E.pseudoQemuAudio:
      case E.pseudoExtendedMouseButtons:
        return { type: 'capability', ...h }
    }
    if (!pixelEncodings.has(encoding)) {
      throw new RfbError(
        'UNSUPPORTED_ENCODING',
        `the server sent a rect in encoding ${encoding}, which this client didn't ask for and can't decode`,
      )
    }
    const result = await this.#pixels(reader, encoding, w, ht, pf)
    return 'data' in result ? { type: 'pixels', ...h, data: result.data } : { type: 'jpeg', ...h, jpeg: result.jpeg }
  }

  async #pixels(
    reader: ByteReader,
    encoding: number,
    w: number,
    h: number,
    pf: PixelFormat,
  ): Promise<{ data: Buffer } | { jpeg: Buffer }> {
    const bpp = bytesPerPixel(pf)
    switch (encoding) {
      case E.raw:
        return { data: await reader.read(w * h * bpp) }
      case E.rre:
        return { data: await decodeRre(reader, w, h, bpp, false) }
      case E.coRre:
        return { data: await decodeRre(reader, w, h, bpp, true) }
      case E.hextile:
        return { data: await decodeHextile(reader, w, h, bpp) }
      case E.zlib: {
        const length = await reader.u32()
        checkZlibLength(length, w * h * bpp, 'Zlib')
        return { data: await this.#zlib.inflate(await reader.read(length), w * h * bpp) }
      }
      case E.trle:
        return { data: await decodeTrle(reader, w, h, pf) }
      case E.zrle:
        return { data: await decodeZrle(reader, this.#zrle, w, h, pf) }
      case E.tight:
        return decodeTight(reader, this.#tight, w, h, pf, false, this.#decodeJpeg)
      case E.tightPng:
        return decodeTight(reader, this.#tight, w, h, pf, true, this.#decodeJpeg)
      default:
        throw new RfbError('UNSUPPORTED_ENCODING', `encoding ${encoding} carries no pixels`)
    }
  }

  close(): void {
    this.#zlib.close()
    this.#zrle.close()
    for (const z of this.#tight) z.close()
  }
}

function leds(bits: number) {
  return { scrollLock: (bits & 1) !== 0, numLock: (bits & 2) !== 0, capsLock: (bits & 4) !== 0 }
}

function checkCursor(w: number, h: number): void {
  if (w > MAX_CURSOR || h > MAX_CURSOR)
    throw protocolError(`a ${w}×${h} cursor is larger than ${MAX_CURSOR}×${MAX_CURSOR}`)
}
