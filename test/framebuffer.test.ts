import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { encodings as E, Framebuffer, pixelFormats } from '../src/index.ts'

/** A 1-byte-per-pixel framebuffer whose pixel at (x, y) is y * w + x. */
function numbered(w: number, h: number): Framebuffer {
  const fb = new Framebuffer(w, h, pixelFormats.bgr233)
  for (let i = 0; i < w * h; i++) fb.data[i] = i
  return fb
}

/** CopyRect semantics: the destination gets the source as it was before the copy. */
function reference(fb: Framebuffer, sx: number, sy: number, x: number, y: number, w: number, h: number): Buffer {
  const before = Buffer.from(fb.data)
  const out = Buffer.from(fb.data)
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) out[(y + r) * fb.width + x + c] = before[(sy + r) * fb.width + sx + c] as number
  return out
}

describe('Framebuffer', () => {
  test('overlapping copies in every direction match CopyRect semantics', () => {
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
      [3, 2],
      [-2, -3],
      [2, -2],
      [-3, 3],
    ] as const) {
      const fb = numbered(14, 12)
      const sx = 4
      const sy = 4
      const expected = reference(fb, sx, sy, sx + dx, sy + dy, 5, 4)
      fb.copy(sx, sy, sx + dx, sy + dy, 5, 4)
      assert.deepEqual(fb.data, expected, `moving by ${dx},${dy}`)
    }
  })

  test('apply: pixels, copy, desktop size; other rects change nothing', () => {
    const fb = new Framebuffer(2, 2, pixelFormats.bgrx)
    const header = { x: 0, y: 0, width: 1, height: 1 }
    assert.equal(fb.apply({ type: 'pixels', ...header, encoding: E.raw, data: Buffer.from([1, 2, 3, 0]) }), true)
    assert.equal(fb.apply({ type: 'copy', ...header, x: 1, y: 1, encoding: E.copyRect, src: { x: 0, y: 0 } }), true)
    assert.deepEqual([...fb.toRgba(undefined, { x: 1, y: 1, width: 1, height: 1 })], [3, 2, 1, 255])
    assert.equal(fb.apply({ type: 'cursorPosition', ...header, encoding: E.pseudoPointerPos }), false)
    assert.equal(
      fb.apply({ type: 'desktopSize', x: 0, y: 0, width: 3, height: 1, encoding: E.pseudoDesktopSize }),
      true,
    )
    assert.equal(fb.width, 3)
    assert.deepEqual([...fb.toRgba().subarray(0, 4)], [3, 2, 1, 255], 'resizing keeps the top-left content')
  })

  test('out-of-bounds operations throw', () => {
    const fb = new Framebuffer(4, 4)
    assert.throws(() => fb.put(3, 3, 2, 1, Buffer.alloc(8)), /outside/)
    assert.throws(() => fb.copy(0, 0, 3, 0, 2, 1), /outside/)
  })
})
