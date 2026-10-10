// Every security type against real servers.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import tls from 'node:tls'
import { type ConnectOptions, connect, type RfbError, security as S } from '../../src/index.ts'
import { HOST, needServer } from './harness.ts'
import {
  PASSWORD,
  qemuVnc,
  type TestServer,
  tigervnc,
  tigervncRa2,
  tigervncRa2User,
  tigervncVencrypt,
  tigervncVnc,
  tightvnc,
  USER,
  x11vncVnc,
} from './servers.ts'

const ca = readFileSync(new URL('../../docker/certs/test-ca.pem', import.meta.url))

async function login(server: TestServer, options: ConnectOptions) {
  const client = await connect({ host: HOST, port: server.port, timeout: 10000, initialUpdate: false, ...options })
  const { securityType, protocolVersion, width } = client
  const encrypted = client.stream instanceof tls.TLSSocket
  await client.close()
  return { securityType, protocolVersion, width, encrypted }
}

describe('VNC authentication', () => {
  for (const server of [tigervncVnc, x11vncVnc, qemuVnc, tightvnc]) {
    test(`${server.name}: right and wrong password`, async (t) => {
      if (!(await needServer(t, server.port, server.name))) return
      assert.equal((await login(server, { password: PASSWORD })).securityType, S.VNC)
      await assert.rejects(login(server, { password: 'wrong' }), (err: RfbError) => err.code === 'AUTH_FAILED')
      await assert.rejects(login(server, {}), (err: RfbError) => err.code === 'AUTH_REQUIRED')
    })
  }
})

describe('protocol versions', () => {
  for (const version of ['3.3', '3.7'] as const) {
    test(`TigerVNC with ${version}`, async (t) => {
      if (!(await needServer(t, tigervncVnc.port, tigervncVnc.name))) return
      const result = await login(tigervncVnc, { password: PASSWORD, maxVersion: version })
      assert.equal(result.protocolVersion, version)
    })
  }
})

describe('VeNCrypt (TigerVNC)', () => {
  const cases: [string, number, ConnectOptions, boolean][] = [
    ['X509Plain', S.X509Plain, { username: USER, password: PASSWORD, tls: { ca } }, true],
    ['X509Vnc', S.X509Vnc, { password: PASSWORD, tls: { ca } }, true],
    ['X509None', S.X509None, { tls: { ca } }, true],
    ['TLSPlain', S.TLSPlain, { username: USER, password: PASSWORD }, true],
    ['TLSVnc', S.TLSVnc, { password: PASSWORD }, true],
    ['TLSNone', S.TLSNone, {}, true],
    ['Plain', S.Plain, { username: USER, password: PASSWORD }, false],
  ]
  for (const [name, subtype, options, encrypted] of cases) {
    test(name, async (t) => {
      if (!(await needServer(t, tigervncVencrypt.port, tigervncVencrypt.name))) return
      const result = await login(tigervncVencrypt, { security: [subtype], ...options })
      assert.equal(result.securityType, S.VeNCrypt)
      assert.equal(result.encrypted, encrypted)
      assert.equal(result.width, 1000)
    })
  }

  test('X509 without the CA fails with TLS_FAILED', async (t) => {
    if (!(await needServer(t, tigervncVencrypt.port, tigervncVencrypt.name))) return
    await assert.rejects(
      login(tigervncVencrypt, { security: [S.X509None] }),
      (err: RfbError) => err.code === 'TLS_FAILED',
    )
  })

  test('TLSPlain with a wrong password', async (t) => {
    if (!(await needServer(t, tigervncVencrypt.port, tigervncVencrypt.name))) return
    await assert.rejects(
      login(tigervncVencrypt, { security: [S.TLSPlain], username: USER, password: 'wrong' }),
      (err: RfbError) => err.code === 'AUTH_FAILED',
    )
  })
})

describe('RSA-AES (TigerVNC)', () => {
  for (const [server, options] of [
    [tigervncRa2, { password: PASSWORD }],
    [tigervncRa2User, { username: USER, password: PASSWORD }],
  ] as const) {
    for (const type of [S.RA2_256, S.RA2, S.RA2ne_256, S.RA2ne]) {
      test(`${server.name}: type ${type}`, async (t) => {
        if (!(await needServer(t, server.port, server.name))) return
        const result = await login(server, { security: [type], ...options })
        assert.equal(result.securityType, type)
        assert.equal(result.width, 1000)
      })
    }
    test(`${server.name}: wrong password`, async (t) => {
      if (!(await needServer(t, server.port, server.name))) return
      await assert.rejects(
        login(server, { security: [S.RA2], ...options, password: 'wrong' }),
        (err: RfbError) => err.code === 'AUTH_FAILED',
      )
    })
  }
})

describe('Tight security type (TightVNC)', () => {
  test('VNC authentication inside Tight, and the server capabilities', async (t) => {
    if (!(await needServer(t, tightvnc.port, tightvnc.name))) return
    const client = await connect({ host: HOST, port: tightvnc.port, password: PASSWORD, security: [S.Tight] })
    assert.equal(client.securityType, S.Tight)
    const signatures = client.tightCapabilities?.encodings.map((c) => c.signature) ?? []
    assert.ok(signatures.includes('TIGHT___'), `capabilities: ${signatures.join(', ')}`)
    await client.close()
  })
})

describe('no common security type', () => {
  test('TigerVNC with None only offered, client wants VNC', async (t) => {
    if (!(await needServer(t, tigervnc.port, tigervnc.name))) return
    await assert.rejects(
      login(tigervnc, { security: [S.VNC], password: 'x' }),
      (err: RfbError) => err.code === 'UNSUPPORTED_SECURITY' && /None \(1\)/.test(err.message),
    )
  })
})
