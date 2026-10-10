// The test servers of docker/compose.yaml. Test-only credentials (see docker/README.md).

export const PASSWORD = 'rfb2test'
export const USER = 'rfb'

export interface TestServer {
  name: string
  port: number
  password?: string
}

export const tigervnc: TestServer = { name: 'TigerVNC', port: 15901 }
export const tigervncVnc: TestServer = { name: 'TigerVNC (VncAuth)', port: 15902, password: PASSWORD }
export const tigervncVencrypt: TestServer = { name: 'TigerVNC (VeNCrypt)', port: 15903, password: PASSWORD }
export const tigervncRa2: TestServer = { name: 'TigerVNC (RSA-AES, password)', port: 15904, password: PASSWORD }
export const tigervncRa2User: TestServer = { name: 'TigerVNC (RSA-AES, user)', port: 15905, password: PASSWORD }
export const x11vnc: TestServer = { name: 'x11vnc', port: 15910 }
export const x11vncVnc: TestServer = { name: 'x11vnc (VncAuth)', port: 15911, password: PASSWORD }
export const tightvnc: TestServer = { name: 'TightVNC', port: 15920, password: PASSWORD }
export const tightvncNone: TestServer = { name: 'TightVNC (no auth)', port: 15921 }
export const turbovnc: TestServer = { name: 'TurboVNC', port: 15930 }
export const qemu: TestServer = { name: 'QEMU', port: 15940 }
export const qemuVnc: TestServer = { name: 'QEMU (VncAuth)', port: 15941, password: PASSWORD }
