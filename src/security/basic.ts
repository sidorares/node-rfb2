import { security } from '../constants.ts'
import { vncAuthResponse } from '../des.ts'
import type { SecurityContext, SecurityOutcome } from './types.ts'

/** None: nothing to exchange. Before 3.8 no SecurityResult follows. */
export async function noneAuth(ctx: SecurityContext): Promise<SecurityOutcome> {
  return { skipResult: ctx.version !== '3.8' }
}

/** VNC authentication: DES-encrypt the server's 16-byte challenge with the password. */
export async function vncAuth(ctx: SecurityContext, type: number = security.VNC): Promise<SecurityOutcome> {
  const challenge = await ctx.reader.read(16)
  const { password } = await ctx.credentials(type, ['password'])
  ctx.write(vncAuthResponse(challenge, password ?? ''))
  return {}
}

/** VeNCrypt Plain and Tight Unix login: U32 lengths, then username and password (UTF-8). */
export async function plainAuth(ctx: SecurityContext, type: number = security.Plain): Promise<SecurityOutcome> {
  const { username, password } = await ctx.credentials(type, ['username', 'password'])
  const user = Buffer.from(username ?? '', 'utf8')
  const pass = Buffer.from(password ?? '', 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt32BE(user.length, 0)
  head.writeUInt32BE(pass.length, 4)
  ctx.write(Buffer.concat([head, user, pass]))
  return {}
}
