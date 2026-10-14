// Protocol numbers from the RFB community specification (https://github.com/rfbproto/rfbproto).
// The names of the 0.x releases (`encodings.raw`, `security.VNC`, `clientMsgTypes.fbUpdate`, ...) are kept.

export const versionstring = {
  V3_003: 'RFB 003.003\n',
  V3_007: 'RFB 003.007\n',
  V3_008: 'RFB 003.008\n',
} as const

export const clientMsgTypes = {
  setPixelFormat: 0,
  setEncodings: 2,
  fbUpdate: 3,
  keyEvent: 4,
  pointerEvent: 5,
  cutText: 6,
  enableContinuousUpdates: 150,
  fence: 248,
  xvp: 250,
  setDesktopSize: 251,
  qemu: 255,
} as const

export const serverMsgTypes = {
  fbUpdate: 0,
  setColorMap: 1,
  bell: 2,
  cutText: 3,
  endOfContinuousUpdates: 150,
  fence: 248,
  xvp: 250,
  qemu: 255,
} as const

/** Encodings and pseudo-encodings (S32 on the wire; the large ones are stored as signed numbers). */
export const encodings = {
  raw: 0,
  copyRect: 1,
  rre: 2,
  coRre: 4,
  hextile: 5,
  zlib: 6,
  tight: 7,
  trle: 15,
  zrle: 16,
  tightPng: -260,

  pseudoDesktopSize: -223,
  pseudoLastRect: -224,
  /** Server-side pointer position (libvncserver's PointerPos). */
  pseudoPointerPos: -232,
  pseudoCursor: -239,
  pseudoXCursor: -240,
  pseudoQemuPointerMotionChange: -257,
  pseudoQemuExtendedKeyEvent: -258,
  pseudoQemuAudio: -259,
  pseudoQemuLedState: -261,
  pseudoDesktopName: -307,
  pseudoExtendedDesktopSize: -308,
  pseudoXvp: -309,
  pseudoFence: -312,
  pseudoContinuousUpdates: -313,
  pseudoCursorWithAlpha: -314,
  pseudoExtendedMouseButtons: -316,
  /** Tight's BasicCompression Without Zlib (decoded either way; this tells the server it may use it). */
  pseudoTightWithoutZlib: -317,
  pseudoVMwareCursor: 0x574d5664,
  pseudoVMwareCursorState: 0x574d5665,
  pseudoVMwareCursorPosition: 0x574d5666,
  pseudoVMwareLedState: 0x574d5668,
  pseudoExtendedClipboard: 0xc0a1e5ce | 0,

  /** Compression level 0..9 is `pseudoCompressionLevel0 + level` (see `compressionLevel()`). */
  pseudoCompressionLevel0: -256,
  /** JPEG quality 0..9 is `pseudoQualityLevel0 + level` (see `jpegQuality()`). */
  pseudoQualityLevel0: -32,
  /** Fine-grained JPEG quality 0..100 is `pseudoFineQualityLevel0 + quality` (TurboVNC). */
  pseudoFineQualityLevel0: -512,
  /** JPEG subsampling is `pseudoSubsampLevel0 + level` (TurboVNC; see `jpegSubsampling`). */
  pseudoSubsampLevel0: -768,
} as const

/** Compression level pseudo-encoding: 0 (fast) .. 9 (small). */
export function compressionLevel(level: number): number {
  return encodings.pseudoCompressionLevel0 + clampInt(level, 0, 9)
}

/** JPEG quality level pseudo-encoding: 0 (worst) .. 9 (best). Enables lossy JPEG in Tight. */
export function jpegQuality(level: number): number {
  return encodings.pseudoQualityLevel0 + clampInt(level, 0, 9)
}

/** Fine-grained JPEG quality pseudo-encoding: 1..100 (TurboVNC, libvncserver). */
export function jpegFineQuality(quality: number): number {
  return encodings.pseudoFineQualityLevel0 + clampInt(quality, 1, 100)
}

/** JPEG chroma subsampling levels for `jpegSubsampling()`. */
export const subsampling = {
  '4:4:4': 0,
  '4:2:0': 1,
  '4:2:2': 2,
  gray: 3,
  '8x': 4,
  '16x': 5,
} as const

export function jpegSubsampling(level: keyof typeof subsampling): number {
  return encodings.pseudoSubsampLevel0 + subsampling[level]
}

export const subEncodings = {
  hextile: {
    raw: 1,
    backgroundSpecified: 2,
    foregroundSpecified: 4,
    anySubrects: 8,
    subrectsColored: 16,
  },
} as const

/** Security types. VeNCrypt subtypes (256+) can be listed in `security` too. */
export const security = {
  None: 1,
  VNC: 2,
  RA2: 5,
  RA2ne: 6,
  Tight: 16,
  VeNCrypt: 19,
  /** Apple Remote Desktop (RFB "Diffie-Hellman Authentication"): macOS Screen Sharing user login. */
  ARD: 30,
  MSLogonII: 113,
  RA2_256: 129,
  RA2ne_256: 130,

  // VeNCrypt subtypes
  Plain: 256,
  TLSNone: 257,
  TLSVnc: 258,
  TLSPlain: 259,
  X509None: 260,
  X509Vnc: 261,
  X509Plain: 262,
} as const

export const connectionFlag = {
  Exclusive: 0,
  Shared: 1,
} as const

/** PointerEvent button mask bits. */
export const buttons = {
  left: 1,
  middle: 2,
  right: 4,
  wheelUp: 8,
  wheelDown: 16,
  wheelLeft: 32,
  wheelRight: 64,
  back: 128,
} as const

/** ClientFence / ServerFence flags. */
export const fenceFlags = {
  blockBefore: 1,
  blockAfter: 2,
  syncNext: 4,
  request: 0x80000000,
} as const

/** xvp message codes. */
export const xvpCodes = {
  fail: 0,
  init: 1,
  shutdown: 2,
  reboot: 3,
  reset: 4,
} as const

/** QEMU audio sample formats. */
export const audioFormats = {
  u8: 0,
  s8: 1,
  u16: 2,
  s16: 3,
  u32: 4,
  s32: 5,
} as const

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)))
}
