import { security as S } from '../constants.ts'
import { protocolError, RfbError } from '../errors.ts'
import type { ByteReader } from '../reader.ts'
import { plainAuth, vncAuth } from './basic.ts'
import type { SecurityContext, SecurityOutcome } from './types.ts'
import { vencryptAuth } from './vencrypt.ts'

/** A Tight capability: code, 4-byte vendor, 8-byte signature. */
export interface TightCapability {
  code: number
  vendor: string
  signature: string
}

export async function readCapabilities(reader: ByteReader, count: number): Promise<TightCapability[]> {
  // The lists in ServerInit have U16 counts; the tunnel and authentication lists' U32 counts get the
  // same bound (servers send a handful), so a count doesn't make the client wait for gigabytes.
  if (count > 0xffff) throw protocolError(`a list of ${count} Tight capabilities`)
  const data = await reader.read(16 * count)
  return Array.from({ length: count }, (_, i) => ({
    code: data.readInt32BE(16 * i),
    vendor: data.toString('latin1', 16 * i + 4, 16 * i + 8),
    signature: data.toString('latin1', 16 * i + 8, 16 * i + 16),
  }))
}

/** Tight auth capability codes (not the standard security type numbers). */
const AUTH = { none: 1, vnc: 2, vencrypt: 19, unixLogin: 129 } as const

/**
 * The Tight security type (TightVNC): an optional tunnel list (only "no tunnel" is supported), then
 * a list of authentication capabilities. ServerInit is extended with the server's capabilities.
 */
export async function tightAuth(ctx: SecurityContext): Promise<SecurityOutcome> {
  const { reader } = ctx
  const tunnels = await readCapabilities(reader, await reader.u32())
  if (tunnels.length > 0) {
    if (!tunnels.some((t) => t.code === 0)) {
      throw new RfbError('UNSUPPORTED_SECURITY', 'the server requires a Tight tunnel; only "no tunnel" is supported')
    }
    ctx.write(Buffer.alloc(4))
  }
  const auths = await readCapabilities(reader, await reader.u32())
  if (auths.length === 0) return { tight: true, skipResult: ctx.version !== '3.8' }

  const codes = auths.map((a) => a.code)
  // Map the client's preference (standard type numbers) onto Tight auth codes.
  const wanted = ctx.preference.flatMap((t) =>
    t === S.None
      ? [AUTH.none]
      : t === S.VNC
        ? [AUTH.vnc]
        : t === S.Plain || t === S.TLSPlain || t === S.X509Plain
          ? [AUTH.unixLogin, AUTH.vencrypt]
          : t >= 256
            ? [AUTH.vencrypt]
            : [],
  )
  const code = [...wanted, AUTH.none, AUTH.vnc].find((c) => codes.includes(c))
  if (code === undefined) {
    throw new RfbError(
      'UNSUPPORTED_SECURITY',
      `the server offers Tight authentication ${auths.map((a) => `${a.vendor}/${a.signature}`).join(', ')}; ` +
        'this client can do None, VNC, VeNCrypt and Unix login',
    )
  }
  const choice = Buffer.alloc(4)
  choice.writeInt32BE(code)
  ctx.write(choice)
  switch (code) {
    case AUTH.none:
      return { tight: true, skipResult: ctx.version !== '3.8' }
    case AUTH.vnc:
      return { tight: true, ...(await vncAuth(ctx, S.Tight)) }
    case AUTH.unixLogin:
      return { tight: true, ...(await plainAuth(ctx, S.Tight)) }
    default:
      return { tight: true, ...(await vencryptAuth(ctx)) }
  }
}
