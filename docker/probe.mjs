#!/usr/bin/env node
// Minimal RFB (VNC) probe for the test servers in this directory; plain Node, no dependencies.
//
//   node docker/probe.mjs [host:]port [options]
//   node docker/probe.mjs --all          probe every service in compose.yaml with its credentials
//                                        and compare its screen with the reference image
//
// Reads the server's version banner, answers with the highest version <= 3.8 it can, prints the
// security types offered, authenticates, prints ServerInit (size, pixel format, desktop name) and,
// with --png / --compare, fetches one non-incremental Raw update of the whole screen.
//
//   --png FILE          write the framebuffer as PNG (asks for 32bpp true colour, SetEncodings [Raw])
//   --compare FILE      compare the framebuffer with a PNG (e.g. docker/assets/testcard.png);
//                       exit status 2 when pixels differ
//   --password PW       for VncAuth, TLSVnc / X509Vnc, Plain types, Tight + VncAuth
//   --user NAME         for Plain / TLSPlain / X509Plain
//   --sec N             security type to choose (default: None if offered, else VncAuth with a
//                       password, else VeNCrypt, Tight, RA2*, else the first one)
//   --vencrypt N        choose VeNCrypt and this subtype (default: the server's first usable one)
//   --ca FILE           CA to verify X509* certificates with (else the certificate is not verified)
//   --exclusive         ClientInit shared-flag 0 (default 1, shared)
//   --timeout MS        overall timeout (default 20000)
//
// Implemented: None, VncAuth, Tight (16: no tunnel; None / VncAuth), VeNCrypt (19: Plain, TLSNone,
// TLSVnc, TLSPlain, X509None, X509Vnc, X509Plain). For the RSA-AES types (5, 6, 129, 130) it prints
// the server's RSA key and stops: their AES-EAX channel is not implemented here.

import { spawnSync } from 'node:child_process'
import { createCipheriv } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { deflateSync, inflateSync } from 'node:zlib'

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    png: { type: 'string' },
    compare: { type: 'string' },
    password: { type: 'string' },
    user: { type: 'string' },
    sec: { type: 'string' },
    vencrypt: { type: 'string' },
    ca: { type: 'string' },
    exclusive: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '20000' },
    all: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
})

// The services in compose.yaml: name, host port (RFB2_PORT_<NAME> overrides it, as in
// compose.yaml) and the probe arguments that log in and check the screen.
const HERE = dirname(fileURLToPath(import.meta.url))
const TESTCARD = join(HERE, 'assets/testcard.png')
const QEMU_CARD = join(HERE, 'assets/qemu-bootcard.png')
const PW = ['--password', 'rfb2test']
const SERVICES = [
  ['tigervnc', 15901, ['--compare', TESTCARD]],
  ['tigervnc-vnc', 15902, [...PW, '--compare', TESTCARD]],
  ['tigervnc-vencrypt', 15903, ['--vencrypt', '262', '--user', 'rfb', ...PW, '--ca', join(HERE, 'certs/test-ca.pem'), '--compare', TESTCARD]],
  ['tigervnc-ra2', 15904, []],
  ['tigervnc-ra2-user', 15905, []],
  ['x11vnc', 15910, ['--compare', TESTCARD]],
  ['x11vnc-vnc', 15911, [...PW, '--compare', TESTCARD]],
  ['tightvnc', 15920, [...PW, '--compare', TESTCARD]],
  ['tightvnc-none', 15921, ['--compare', TESTCARD]],
  ['turbovnc', 15930, ['--compare', TESTCARD]],
  ['qemu', 15940, ['--compare', QEMU_CARD]],
  ['qemu-vnc', 15941, [...PW, '--compare', QEMU_CARD]],
]
if (opt.all) {
  let failed = 0
  for (const [name, defaultPort, args] of SERVICES) {
    const env = `RFB2_PORT_${name.toUpperCase().replaceAll('-', '_')}`
    const p = process.env[env] ?? defaultPort
    console.log(`== ${name} (127.0.0.1:${p})`)
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `127.0.0.1:${p}`, ...args], {
      encoding: 'utf8',
    })
    const lines = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l && !l.startsWith('choosing'))
    for (const l of lines) console.log(`   ${l}`)
    if (r.status !== 0) failed++
  }
  console.log(failed ? `${failed} of ${SERVICES.length} services FAILED` : `all ${SERVICES.length} services OK`)
  process.exit(failed ? 1 : 0)
}

if (opt.help || positionals.length !== 1) {
  console.error('usage: node docker/probe.mjs --all')
  console.error('       node docker/probe.mjs [host:]port [--png out.png] [--compare ref.png] [--password pw]')
  console.error('         [--user name] [--sec type] [--vencrypt subtype] [--ca ca.pem] [--exclusive] [--timeout ms]')
  process.exit(opt.help ? 0 : 64)
}
const target = positionals[0]
const colon = target.lastIndexOf(':')
const host = colon > 0 ? target.slice(0, colon).replace(/^\[|\]$/g, '') : '127.0.0.1'
const port = Number(colon >= 0 ? target.slice(colon + 1) : target)

const SEC_TYPES = {
  0: 'Invalid',
  1: 'None',
  2: 'VncAuth',
  5: 'RA2',
  6: 'RA2ne',
  7: 'SSPI',
  8: 'SSPIne',
  16: 'Tight',
  17: 'Ultra',
  18: 'TLS',
  19: 'VeNCrypt',
  20: 'SASL',
  21: 'MD5',
  22: 'xvp',
  30: 'DH (Apple)',
  113: 'MSLogonII',
  129: 'RA2_256',
  130: 'RA2ne_256',
}
const VENCRYPT = {
  1: 'None',
  2: 'VncAuth',
  256: 'Plain',
  257: 'TLSNone',
  258: 'TLSVnc',
  259: 'TLSPlain',
  260: 'X509None',
  261: 'X509Vnc',
  262: 'X509Plain',
  263: 'TLSSASL',
  264: 'X509SASL',
}
const secName = (t) => `${t} ${SEC_TYPES[t] ?? '?'}`
const subName = (t) => `${t} ${VENCRYPT[t] ?? '?'}`

class ProbeError extends Error {}

// Buffered reader over a socket; can move from the TCP socket to a TLS socket.
class Reader {
  bufs = []
  len = 0
  waiter = null
  error = null
  attach(stream) {
    this.stream = stream
    this.handlers = {
      data: (d) => {
        this.bufs.push(d)
        this.len += d.length
        this.wake()
      },
      end: () => this.fail(new ProbeError('connection closed by the server')),
      close: () => this.fail(new ProbeError('connection closed')),
      error: (e) => this.fail(e),
    }
    for (const [ev, fn] of Object.entries(this.handlers)) stream.on(ev, fn)
  }
  detach() {
    for (const [ev, fn] of Object.entries(this.handlers)) this.stream.off(ev, fn)
  }
  fail(e) {
    this.error ??= e
    this.wake()
  }
  wake() {
    const w = this.waiter
    this.waiter = null
    w?.()
  }
  async read(n) {
    while (this.len < n) {
      if (this.error) throw this.error
      await new Promise((r) => {
        this.waiter = r
      })
    }
    const all = this.bufs.length === 1 ? this.bufs[0] : Buffer.concat(this.bufs)
    this.bufs = [all.subarray(n)]
    this.len -= n
    return all.subarray(0, n)
  }
  u8 = async () => (await this.read(1))[0]
  u16 = async () => (await this.read(2)).readUInt16BE()
  u32 = async () => (await this.read(4)).readUInt32BE()
  s32 = async () => (await this.read(4)).readInt32BE()
  write(buf) {
    this.stream.write(buf)
  }
}

const u32 = (v) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v)
  return b
}

// VNC authentication: DES-encrypt the challenge with the password (bit-reversed bytes) as key.
function vncResponse(password, challenge) {
  const key = Buffer.alloc(8)
  Buffer.from(password, 'latin1').copy(key, 0, 0, 8)
  for (let i = 0; i < 8; i++) {
    let b = key[i]
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4)
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2)
    key[i] = ((b & 0xaa) >> 1) | ((b & 0x55) << 1)
  }
  let cipher
  try {
    cipher = createCipheriv('des-ecb', key, null)
  } catch {
    // OpenSSL 3 keeps single DES in the legacy provider; 3DES with K1 = K2 = K3 is single DES.
    cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null)
  }
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(challenge), cipher.final()])
}

async function securityResult(r, minor, label) {
  const result = await r.u32()
  if (result === 0) {
    console.log(`security result: OK (${label}) (${at()})`)
    return
  }
  let reason = ''
  if (minor >= 8) {
    try {
      reason = (await r.read(await r.u32())).toString('utf8')
    } catch {}
  }
  throw new ProbeError(`security result: failed (${result}) ${label}${reason ? `: ${reason}` : ''}`)
}

async function vncAuth(r) {
  if (opt.password === undefined) throw new ProbeError('VNC authentication needs --password')
  const challenge = await r.read(16)
  r.write(vncResponse(opt.password, challenge))
}

async function plainAuth(r) {
  if (opt.user === undefined || opt.password === undefined) throw new ProbeError('Plain needs --user and --password')
  const u = Buffer.from(opt.user, 'utf8')
  const p = Buffer.from(opt.password, 'utf8')
  r.write(Buffer.concat([u32(u.length), u32(p.length), u, p]))
}

async function startTLS(r, socket, anon) {
  r.detach()
  const options = anon
    ? {
        socket,
        // Anonymous (no certificate) cipher suites exist only up to TLS 1.2, and OpenSSL offers them
        // only at security level 0. TigerVNC (GnuTLS) accepts the ECDH ones (AECDH-*), not ADH-*.
        ciphers: 'AECDH-AES256-SHA:AECDH-AES128-SHA:ADH-AES256-GCM-SHA384:ADH-AES128-GCM-SHA256:@SECLEVEL=0',
        maxVersion: 'TLSv1.2',
        rejectUnauthorized: false,
      }
    : {
        socket,
        ca: opt.ca ? readFileSync(opt.ca) : undefined,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: Boolean(opt.ca),
        checkServerIdentity: (h, cert) => tls.checkServerIdentity(host, cert),
      }
  const t = tls.connect(options)
  await new Promise((resolve, reject) => {
    t.once('secureConnect', resolve)
    t.once('error', reject)
  })
  const cipher = t.getCipher()
  let line = `TLS: ${t.getProtocol()} ${cipher.standardName ?? cipher.name}`
  if (!anon) {
    const cert = t.getPeerCertificate()
    line += `; certificate CN=${cert.subject?.CN} issuer CN=${cert.issuer?.CN} SAN ${cert.subjectaltname}`
    line += opt.ca ? '; verified against --ca' : '; NOT verified (no --ca)'
  }
  console.log(line)
  r.error = null
  r.attach(t)
  return t
}

const PF32 = { bpp: 32, depth: 24, bigEndian: 0, trueColour: 1, rmax: 255, gmax: 255, bmax: 255, rshift: 16, gshift: 8, bshift: 0 }

function parsePF(b) {
  return {
    bpp: b[0],
    depth: b[1],
    bigEndian: b[2],
    trueColour: b[3],
    rmax: b.readUInt16BE(4),
    gmax: b.readUInt16BE(6),
    bmax: b.readUInt16BE(8),
    rshift: b[10],
    gshift: b[11],
    bshift: b[12],
  }
}
function encodePF(pf) {
  const b = Buffer.alloc(16)
  b[0] = pf.bpp
  b[1] = pf.depth
  b[2] = pf.bigEndian
  b[3] = pf.trueColour
  b.writeUInt16BE(pf.rmax, 4)
  b.writeUInt16BE(pf.gmax, 6)
  b.writeUInt16BE(pf.bmax, 8)
  b[10] = pf.rshift
  b[11] = pf.gshift
  b[12] = pf.bshift
  return b
}
const describePF = (pf) =>
  `${pf.bpp}bpp depth ${pf.depth} ${pf.bigEndian ? 'big' : 'little'}-endian ` +
  `${pf.trueColour ? 'true-colour' : 'colour-map'} ` +
  `r${pf.rmax}<<${pf.rshift} g${pf.gmax}<<${pf.gshift} b${pf.bmax}<<${pf.bshift}`

// --- PNG ------------------------------------------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  return Buffer.concat([u32(data.length), td, u32(crc32(td))])
}
function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
// 8-bit RGB / RGBA, non-interlaced PNGs only (what make-testcard.mjs and this probe write).
function decodePNG(buf) {
  let off = 8
  let w
  let h
  let channels
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0 || (data[9] !== 2 && data[9] !== 6))
        throw new ProbeError('--compare: only 8-bit RGB / RGBA non-interlaced PNGs are supported')
      channels = data[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const px = new Uint8Array(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]
      const a = i >= channels ? px[y * stride + i - channels] : 0
      const b = y ? px[(y - 1) * stride + i] : 0
      const c = y && i >= channels ? px[(y - 1) * stride + i - channels] : 0
      let p = 0
      if (f === 1) p = a
      else if (f === 2) p = b
      else if (f === 3) p = (a + b) >> 1
      else if (f === 4) {
        const q = a + b - c
        const pa = Math.abs(q - a)
        const pb = Math.abs(q - b)
        const pc = Math.abs(q - c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[y * stride + i] = (x + p) & 0xff
    }
  }
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0, j = 0; i < w * h; i++, j += channels) rgb.set(px.subarray(j, j + 3), i * 3)
  return { w, h, rgb }
}

// --- Framebuffer ----------------------------------------------------------------------------------
async function fetchFramebuffer(r, width, height) {
  r.write(Buffer.concat([Buffer.from([0, 0, 0, 0]), encodePF(PF32)])) // SetPixelFormat
  r.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])) // SetEncodings [Raw]
  const request = () => {
    const b = Buffer.alloc(10)
    b[0] = 3 // FramebufferUpdateRequest, non-incremental
    b.writeUInt16BE(width, 6)
    b.writeUInt16BE(height, 8)
    r.write(b)
  }
  request()
  let rgb = new Uint8Array(width * height * 3)
  let covered = new Uint8Array(width * height)
  let left = width * height
  let updates = 0
  while (left > 0) {
    const type = await r.u8()
    if (type === 0) {
      await r.read(1)
      const n = await r.u16()
      updates++
      for (let i = 0; i < n; i++) {
        const x = await r.u16()
        const y = await r.u16()
        const w = await r.u16()
        const h = await r.u16()
        const enc = await r.s32()
        if (enc === -223) {
          // DesktopSize (servers may send it even unasked)
          console.log(`DesktopSize: ${w}x${h}`)
          width = w
          height = h
          rgb = new Uint8Array(width * height * 3)
          covered = new Uint8Array(width * height)
          left = width * height
          continue
        }
        if (enc !== 0) throw new ProbeError(`unexpected encoding ${enc} (asked for Raw only)`)
        const data = await r.read(w * h * 4)
        for (let row = 0; row < h; row++)
          for (let col = 0; col < w; col++) {
            const s = (row * w + col) * 4
            const p = (y + row) * width + x + col
            const v = data.readUInt32LE(s)
            rgb[p * 3] = (v >> 16) & 0xff
            rgb[p * 3 + 1] = (v >> 8) & 0xff
            rgb[p * 3 + 2] = v & 0xff
            if (!covered[p]) {
              covered[p] = 1
              left--
            }
          }
      }
      if (left > 0) request()
    } else if (type === 1) {
      await r.read(1)
      await r.u16()
      await r.read((await r.u16()) * 6)
    } else if (type === 2) {
      // Bell
    } else if (type === 3) {
      await r.read(3)
      await r.read(await r.u32())
    } else {
      throw new ProbeError(`unexpected server message type ${type}`)
    }
  }
  return { width, height, rgb, updates }
}

// --- Main -----------------------------------------------------------------------------------------
const t0 = performance.now()
const at = () => `+${Math.round(performance.now() - t0)} ms`

async function main() {
  const socket = net.connect({ host, port })
  socket.setNoDelay(true)
  const r = new Reader()
  r.attach(socket)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const banner = (await r.read(12)).toString('latin1')
  const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner)
  if (!m) throw new ProbeError(`not an RFB server: ${JSON.stringify(banner)}`)
  const [smaj, smin] = [Number(m[1]), Number(m[2])]
  const minor = smaj > 3 || (smaj === 3 && smin >= 8) ? 8 : smaj === 3 && smin === 7 ? 7 : 3
  console.log(`${host}:${port} server version ${m[1]}.${m[2]}, using 3.${minor} (${at()})`)
  r.write(Buffer.from(`RFB 003.00${minor}\n`, 'latin1'))

  let type
  if (minor === 3) {
    type = await r.u32()
    if (type === 0) throw new ProbeError(`connection failed: ${(await r.read(await r.u32())).toString()}`)
    console.log(`security type (chosen by the server, 3.3): ${secName(type)}`)
  } else {
    const n = await r.u8()
    if (n === 0) throw new ProbeError(`connection failed: ${(await r.read(await r.u32())).toString()}`)
    const offered = [...(await r.read(n))]
    console.log(`security types offered: ${offered.map(secName).join(', ')}`)
    if (opt.sec !== undefined) type = Number(opt.sec)
    else if (opt.vencrypt !== undefined) type = 19
    else if (offered.includes(1)) type = 1
    else if (offered.includes(2) && opt.password !== undefined) type = 2
    else type = [19, 16, 129, 5, 130, 6].find((t) => offered.includes(t)) ?? offered[0]
    if (!offered.includes(type)) throw new ProbeError(`security type ${type} not offered`)
    console.log(`choosing ${secName(type)}`)
    r.write(Buffer.from([type]))
  }

  let tightCaps = false
  let stream = socket
  if (type === 1) {
    if (minor >= 8) await securityResult(r, minor, 'None')
  } else if (type === 2) {
    await vncAuth(r)
    await securityResult(r, minor, 'VncAuth')
  } else if (type === 16) {
    tightCaps = true
    const caps = async (what) => {
      const n = await r.u32()
      const list = []
      for (let i = 0; i < n; i++) {
        const b = await r.read(16)
        list.push({ code: b.readInt32BE(0), name: `${b.toString('latin1', 4, 8)}:${b.toString('latin1', 8, 16)}` })
      }
      console.log(`Tight ${what}: ${list.map((c) => `${c.code} ${c.name}`).join(', ') || '(none)'}`)
      return list
    }
    const tunnels = await caps('tunnel types')
    if (tunnels.length) r.write(u32(0)) // NOTUNNEL
    const auths = await caps('auth types')
    if (auths.length) {
      const pick = opt.password !== undefined && auths.some((a) => a.code === 2) ? 2 : auths[0].code
      r.write(u32(pick))
      if (pick === 2) await vncAuth(r)
      else if (pick !== 1) throw new ProbeError(`Tight auth type ${pick} not implemented`)
      await securityResult(r, minor, `Tight + ${pick === 2 ? 'VncAuth' : 'None'}`)
    } else if (minor >= 8) await securityResult(r, minor, 'Tight, no auth')
  } else if (type === 19) {
    const vmaj = await r.u8()
    const vmin = await r.u8()
    console.log(`VeNCrypt version ${vmaj}.${vmin}`)
    r.write(Buffer.from([0, 2]))
    if ((await r.u8()) !== 0) throw new ProbeError('VeNCrypt version 0.2 refused')
    const n = await r.u8()
    const subs = []
    for (let i = 0; i < n; i++) subs.push(await r.u32())
    console.log(`VeNCrypt subtypes offered: ${subs.map(subName).join(', ')}`)
    const usable = (s) =>
      [1, 257, 260].includes(s) ||
      (s === 2 && opt.password !== undefined) ||
      ([258, 261].includes(s) && opt.password !== undefined) ||
      ([256, 259, 262].includes(s) && opt.user !== undefined && opt.password !== undefined)
    const sub = opt.vencrypt !== undefined ? Number(opt.vencrypt) : subs.find(usable)
    if (sub === undefined || !subs.includes(sub)) throw new ProbeError('no usable VeNCrypt subtype (try --vencrypt)')
    console.log(`choosing VeNCrypt ${subName(sub)}`)
    r.write(u32(sub))
    if (sub >= 257 && sub <= 262) {
      if ((await r.u8()) !== 1) throw new ProbeError('server refused to start TLS')
      stream = await startTLS(r, socket, sub <= 259)
    }
    const inner = sub < 256 ? sub : (sub - 256) % 3 // 0: Plain, 1: None, 2: Vnc
    if (inner === 0) await plainAuth(r)
    else if (inner === 2) await vncAuth(r)
    else if (inner !== 1) throw new ProbeError(`VeNCrypt subtype ${sub} not implemented in this probe`)
    await securityResult(r, minor, `VeNCrypt ${VENCRYPT[sub]}`)
  } else if ([5, 6, 129, 130].includes(type)) {
    const bits = await r.u32()
    const bytes = Math.ceil(bits / 8)
    const n = await r.read(bytes)
    const e = await r.read(bytes)
    console.log(
      `RSA-AES: server RSA key ${bits} bits, e=${BigInt(`0x${e.toString('hex')}`)}, ` +
        `modulus ${n.subarray(0, 8).toString('hex')}...`,
    )
    console.log('RSA-AES authentication is not implemented in this probe; stopping here')
    socket.destroy()
    return 0
  } else {
    throw new ProbeError(`security type ${type} not implemented in this probe`)
  }

  r.write(Buffer.from([opt.exclusive ? 0 : 1])) // ClientInit
  const width = await r.u16()
  const height = await r.u16()
  const pf = parsePF(await r.read(16))
  const name = (await r.read(await r.u32())).toString('utf8')
  console.log(`ServerInit: ${width}x${height}, ${describePF(pf)}, name ${JSON.stringify(name)} (${at()})`)
  if (tightCaps) {
    const ns = await r.u16()
    const nc = await r.u16()
    const ne = await r.u16()
    await r.u16()
    const read = async (n) => {
      const list = []
      for (let i = 0; i < n; i++) {
        const b = await r.read(16)
        list.push(`${b.readInt32BE(0)} ${b.toString('latin1', 4, 8)}:${b.toString('latin1', 8, 16)}`)
      }
      return list
    }
    console.log(`Tight server messages: ${(await read(ns)).join(', ')}`)
    console.log(`Tight client messages: ${(await read(nc)).join(', ')}`)
    console.log(`Tight encodings: ${(await read(ne)).join(', ')}`)
  }

  let status = 0
  if (opt.png || opt.compare) {
    const t1 = performance.now()
    const fb = await fetchFramebuffer(r, width, height)
    const ms = Math.round(performance.now() - t1)
    console.log(`framebuffer: ${fb.width}x${fb.height} Raw in ${fb.updates} update(s), ${ms} ms after the request (${at()})`)
    if (opt.png) {
      writeFileSync(opt.png, encodePNG(fb.width, fb.height, fb.rgb))
      console.log(`wrote ${opt.png}`)
    }
    if (opt.compare) {
      const ref = decodePNG(readFileSync(opt.compare))
      if (ref.w !== fb.width || ref.h !== fb.height) {
        console.log(`compare: size differs (${opt.compare} is ${ref.w}x${ref.h})`)
        status = 2
      } else {
        let diff = 0
        let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1]
        for (let p = 0; p < ref.w * ref.h; p++) {
          const i = p * 3
          if (ref.rgb[i] !== fb.rgb[i] || ref.rgb[i + 1] !== fb.rgb[i + 1] || ref.rgb[i + 2] !== fb.rgb[i + 2]) {
            diff++
            const x = p % ref.w
            const y = Math.floor(p / ref.w)
            x0 = Math.min(x0, x)
            y0 = Math.min(y0, y)
            x1 = Math.max(x1, x)
            y1 = Math.max(y1, y)
          }
        }
        if (diff === 0) console.log(`compare: identical to ${opt.compare}`)
        else {
          console.log(`compare: ${diff} pixels differ from ${opt.compare}, within (${x0},${y0})-(${x1},${y1})`)
          status = 2
        }
      }
    }
  }
  stream.destroy()
  socket.destroy()
  return status
}

const timer = setTimeout(() => {
  console.error(`probe: timed out after ${opt.timeout} ms`)
  process.exit(1)
}, Number(opt.timeout))
main().then(
  (status) => {
    clearTimeout(timer)
    process.exitCode = status
  },
  (e) => {
    clearTimeout(timer)
    console.error(`probe: ${e instanceof ProbeError ? e.message : e.stack}`)
    process.exitCode = 1
  },
)
