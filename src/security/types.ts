import type tls from 'node:tls'
import { security } from '../constants.ts'
import type { ByteReader } from '../reader.ts'
import type { Cipher } from '../transport.ts'

export type ProtocolVersion = '3.3' | '3.7' | '3.8'

export interface Credentials {
  username?: string
  password?: string
}

export type CredentialName = 'username' | 'password'

/** What a security handler can use: the byte stream, credentials, TLS and cipher upgrades. */
export interface SecurityContext {
  reader: ByteReader
  write(data: Buffer): void
  version: ProtocolVersion
  /** The client's security preference (standard types and VeNCrypt subtypes). */
  preference: readonly number[]
  /** Asks for credentials; throws AUTH_REQUIRED when they can't be had. */
  credentials(securityType: number, needs: readonly CredentialName[]): Promise<Credentials>
  /** TLS options for VeNCrypt (the `tls` connect option plus the host name). */
  tlsOptions(anonymous: boolean): tls.ConnectionOptions
  startTls(options: tls.ConnectionOptions): Promise<void>
  setCipher(cipher: Cipher | null): void
}

export interface SecurityOutcome {
  /** No SecurityResult message follows. */
  skipResult?: boolean
  /** The Tight security type was used: ServerInit carries interaction capabilities. */
  tight?: boolean
}

export type SecurityHandler = (ctx: SecurityContext, type: number) => Promise<SecurityOutcome | undefined>

const names: Record<number, string> = Object.fromEntries(Object.entries(security).map(([name, n]) => [n, name]))
Object.assign(names, { 0: 'Invalid', 13: 'RA2r', 20: 'SASL', 22: 'xvp', 133: 'RA2r_256' })

/** A security type's name for messages, e.g. `VNC (2)`. */
export function securityName(type: number): string {
  const name = names[type] ?? (type >= 31 && type <= 36 ? 'Apple' : undefined)
  return name ? `${name} (${type})` : `type ${type}`
}
