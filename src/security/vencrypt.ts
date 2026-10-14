import { security as S } from '../constants.ts'
import { protocolError, RfbError } from '../errors.ts'
import { noneAuth, plainAuth, vncAuth } from './basic.ts'
import { type SecurityContext, type SecurityOutcome, securityName } from './types.ts'

const TLS_ANONYMOUS = new Set<number>([S.TLSNone, S.TLSVnc, S.TLSPlain])
const TLS_X509 = new Set<number>([S.X509None, S.X509Vnc, S.X509Plain])
/** VeNCrypt subtypes this client can do (plus the plain None and VNC types, which may be listed too). */
const SUPPORTED = new Set<number>([S.None, S.VNC, S.Plain, ...TLS_ANONYMOUS, ...TLS_X509])

/**
 * VeNCrypt 0.2: pick a subtype, upgrade to TLS for the TLS* (anonymous) and X509* (certificate)
 * subtypes, then authenticate with None, VNC or Plain inside it.
 */
export async function vencryptAuth(ctx: SecurityContext): Promise<SecurityOutcome> {
  const { reader } = ctx
  const [major, minor] = await reader.read(2)
  if (major !== 0 || (minor as number) < 2) {
    throw new RfbError(
      'UNSUPPORTED_SECURITY',
      `the server speaks VeNCrypt ${major}.${minor}; this client needs 0.2 or later`,
    )
  }
  ctx.write(Buffer.from([0, 2]))
  if ((await reader.u8()) !== 0) throw new RfbError('UNSUPPORTED_SECURITY', 'the server refused VeNCrypt 0.2')

  const count = await reader.u8()
  const list = await reader.read(4 * count)
  const offered = Array.from({ length: count }, (_, i) => list.readUInt32BE(4 * i))
  const subtype = ctx.preference.find((t) => offered.includes(t) && SUPPORTED.has(t))
  if (subtype === undefined) {
    throw new RfbError(
      'UNSUPPORTED_SECURITY',
      `the server offers VeNCrypt subtypes ${offered.map(securityName).join(', ') || 'none'}, ` +
        `none of which is in this client's \`security\` list (${ctx.preference.map(securityName).join(', ')})`,
    )
  }
  const choice = Buffer.alloc(4)
  choice.writeUInt32BE(subtype)
  ctx.write(choice)

  const anonymous = TLS_ANONYMOUS.has(subtype)
  if (anonymous || TLS_X509.has(subtype)) {
    if ((await reader.u8()) !== 1) throw protocolError(`the server refused VeNCrypt subtype ${securityName(subtype)}`)
    await ctx.startTls(ctx.tlsOptions(anonymous))
  }

  switch (subtype) {
    case S.None:
      return noneAuth(ctx)
    case S.TLSNone:
    case S.X509None:
      return {}
    case S.VNC:
    case S.TLSVnc:
    case S.X509Vnc:
      return vncAuth(ctx, subtype)
    default:
      return plainAuth(ctx, subtype)
  }
}
