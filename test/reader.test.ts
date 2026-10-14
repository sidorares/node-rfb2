import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RfbError } from '../src/errors.ts'
import { BufferCursor, ByteReader } from '../src/reader.ts'

describe('ByteReader', () => {
  test('reads wait for enough data and span chunks', async () => {
    const r = new ByteReader()
    const first = r.read(5)
    r.push(Buffer.from([1, 2]))
    r.push(Buffer.from([3]))
    r.push(Buffer.from([4, 5, 6, 7]))
    assert.deepEqual([...(await first)], [1, 2, 3, 4, 5])
    assert.equal(r.available, 2)
    assert.equal(await r.u16(), 0x0607)
  })

  test('typed big-endian reads', async () => {
    const r = new ByteReader()
    r.push(Buffer.from([0xff, 0x01, 0x02, 0xff, 0xff, 0xff, 0xfe, 0x80, 0, 0, 0, 0x41, 0x42]))
    assert.equal(await r.u8(), 0xff)
    assert.equal(await r.u16(), 0x0102)
    assert.equal(await r.s32(), -2)
    assert.equal(await r.u32(), 0x80000000)
    assert.equal(await r.string(2), 'AB')
  })

  test('reads within one chunk are zero-copy', async () => {
    const r = new ByteReader()
    const chunk = Buffer.from([1, 2, 3, 4])
    r.push(chunk)
    const b = await r.read(2)
    assert.equal(b.buffer, chunk.buffer)
  })

  test('a zero-length read completes at once', async () => {
    const r = new ByteReader()
    assert.equal((await r.read(0)).length, 0)
  })

  test('destroy fails the pending read, buffered bytes stay readable', async () => {
    const r = new ByteReader()
    r.push(Buffer.from([1, 2]))
    const err = new RfbError('CONNECTION_CLOSED', 'closed')
    r.destroy(err)
    assert.deepEqual([...(await r.read(2))], [1, 2])
    await assert.rejects(r.read(1), err)
    const r2 = new ByteReader()
    const pending = r2.read(4)
    r2.destroy(err)
    await assert.rejects(pending, err)
  })

  test('one read at a time', () => {
    const r = new ByteReader()
    void r.read(1)
    assert.throws(() => r.read(1), /one read/)
  })

  test('peek, consume and waitFor', async () => {
    const r = new ByteReader()
    r.push(Buffer.from([1, 2]))
    r.push(Buffer.from([3]))
    assert.deepEqual([...r.peek()], [1, 2, 3])
    r.consume(1)
    const waiting = r.waitFor(4)
    r.push(Buffer.from([4, 5]))
    assert.deepEqual([...(await waiting)], [2, 3, 4, 5])
    assert.equal(r.available, 4, 'waitFor consumes nothing')
    assert.equal(r.readNow(5), null)
    assert.deepEqual([...(r.readNow(4) as Buffer)], [2, 3, 4, 5])
  })

  test('lengthPrefixedString refuses absurd lengths', async () => {
    const r = new ByteReader()
    r.push(Buffer.from([0x7f, 0xff, 0xff, 0xff]))
    await assert.rejects(r.lengthPrefixedString('utf8', 100), (err: RfbError) => err.code === 'PROTOCOL_ERROR')
  })
})

describe('BufferCursor', () => {
  test('reads and refuses to run past the end', () => {
    const c = new BufferCursor(Buffer.from([1, 0, 2, 0, 0, 0, 3, 9]))
    assert.equal(c.u8(), 1)
    assert.equal(c.u16(), 2)
    assert.equal(c.u32(), 3)
    assert.equal(c.remaining, 1)
    assert.throws(
      () => c.u16('tile'),
      (err: RfbError) => err.code === 'PROTOCOL_ERROR' && /tile/.test(err.message),
    )
  })
})
