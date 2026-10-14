// DES (FIPS 46-3) for VNC authentication and MS Logon II. Node's OpenSSL 3 no longer offers single
// DES (`des-ecb` is in the legacy provider) and other runtimes lack 3DES, so it is implemented here.
// It runs a few blocks per connection; clarity beats speed.

// Tables use FIPS 46-3's 1-based bit positions, bit 1 being the most significant.
// biome-ignore format: tables
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
]
// biome-ignore format: tables
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
]
// biome-ignore format: tables
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
]
// biome-ignore format: tables
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25]
// biome-ignore format: tables
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
]
// biome-ignore format: tables
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
]
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
// biome-ignore format: tables
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
]

type Bits = Uint8Array

function toBits(bytes: Uint8Array): Bits {
  const bits = new Uint8Array(bytes.length * 8)
  for (let i = 0; i < bits.length; i++) bits[i] = ((bytes[i >> 3] as number) >> (7 - (i & 7))) & 1
  return bits
}

function fromBits(bits: Bits): Uint8Array {
  const bytes = new Uint8Array(bits.length / 8)
  for (let i = 0; i < bits.length; i++)
    bytes[i >> 3] = (bytes[i >> 3] as number) | ((bits[i] as number) << (7 - (i & 7)))
  return bytes
}

function permute(bits: Bits, table: readonly number[]): Bits {
  const out = new Uint8Array(table.length)
  for (let i = 0; i < table.length; i++) out[i] = bits[(table[i] as number) - 1] as number
  return out
}

/** A DES key schedule; encrypts and decrypts 8-byte blocks. */
export class Des {
  readonly #subkeys: Bits[]

  constructor(key: Uint8Array) {
    if (key.length !== 8) throw new Error('a DES key is 8 bytes')
    const cd = permute(toBits(key), PC1)
    let c = cd.slice(0, 28)
    let d = cd.slice(28)
    this.#subkeys = SHIFTS.map((n) => {
      c = Uint8Array.from([...c.subarray(n), ...c.subarray(0, n)])
      d = Uint8Array.from([...d.subarray(n), ...d.subarray(0, n)])
      return permute(Uint8Array.from([...c, ...d]), PC2)
    })
  }

  encryptBlock(block: Uint8Array): Uint8Array {
    return this.#crypt(block, false)
  }

  decryptBlock(block: Uint8Array): Uint8Array {
    return this.#crypt(block, true)
  }

  /** ECB over whole blocks (`data.length` must be a multiple of 8). */
  encryptEcb(data: Uint8Array): Buffer {
    const out = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i += 8) out.set(this.encryptBlock(data.subarray(i, i + 8)), i)
    return out
  }

  /** CBC over whole blocks. */
  encryptCbc(data: Uint8Array, iv: Uint8Array): Buffer {
    const out = Buffer.alloc(data.length)
    let prev = iv
    for (let i = 0; i < data.length; i += 8) {
      const block = new Uint8Array(8)
      for (let j = 0; j < 8; j++) block[j] = (data[i + j] as number) ^ (prev[j] as number)
      prev = this.encryptBlock(block)
      out.set(prev, i)
    }
    return out
  }

  /** CBC decryption over whole blocks. */
  decryptCbc(data: Uint8Array, iv: Uint8Array): Buffer {
    const out = Buffer.alloc(data.length)
    let prev = iv
    for (let i = 0; i < data.length; i += 8) {
      const block = data.subarray(i, i + 8)
      const plain = this.decryptBlock(block)
      for (let j = 0; j < 8; j++) out[i + j] = (plain[j] as number) ^ (prev[j] as number)
      prev = block
    }
    return out
  }

  #crypt(block: Uint8Array, decrypt: boolean): Uint8Array {
    if (block.length !== 8) throw new Error('a DES block is 8 bytes')
    const bits = permute(toBits(block), IP)
    let l = bits.slice(0, 32)
    let r = bits.slice(32)
    for (let round = 0; round < 16; round++) {
      const k = this.#subkeys[decrypt ? 15 - round : round] as Bits
      const e = permute(r, E)
      const f = new Uint8Array(32)
      for (let s = 0; s < 8; s++) {
        const o = s * 6
        const x = (i: number) => (e[o + i] as number) ^ (k[o + i] as number)
        const row = (x(0) << 1) | x(5)
        const col = (x(1) << 3) | (x(2) << 2) | (x(3) << 1) | x(4)
        const v = (S[s] as number[])[row * 16 + col] as number
        for (let b = 0; b < 4; b++) f[s * 4 + b] = (v >> (3 - b)) & 1
      }
      const pf = permute(f, P)
      const next = new Uint8Array(32)
      for (let i = 0; i < 32; i++) next[i] = (l[i] as number) ^ (pf[i] as number)
      l = r
      r = next
    }
    return fromBits(permute(Uint8Array.from([...r, ...l]), FP))
  }
}

/** Reverses the bits of a byte: VNC uses the lowest bit of each password byte as the first DES key bit. */
function reverseBits(b: number): number {
  let r = 0
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i)
  return r
}

/** The DES key VNC derives from a password: its first 8 bytes, zero-padded, each byte bit-reversed. */
export function vncKey(password: string | Uint8Array): Uint8Array {
  const bytes = typeof password === 'string' ? Buffer.from(password, 'utf8') : password
  const key = new Uint8Array(8)
  for (let i = 0; i < 8 && i < bytes.length; i++) key[i] = reverseBits(bytes[i] as number)
  return key
}

/** The 16-byte response to a VNC authentication challenge. */
export function vncAuthResponse(challenge: Uint8Array, password: string | Uint8Array): Buffer {
  return new Des(vncKey(password)).encryptEcb(challenge)
}
