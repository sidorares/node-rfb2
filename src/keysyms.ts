/** X11 keysyms for keys that aren't characters (from X11/keysymdef.h). */
export const keysyms = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Insert: 0xff63,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  CapsLock: 0xffe5,
  /** Meta is rarely mapped on X servers; the Windows/Command key is usually `SuperLeft`. */
  MetaLeft: 0xffe7,
  MetaRight: 0xffe8,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  SuperLeft: 0xffeb,
  SuperRight: 0xffec,
  AltGr: 0xfe03,
  Menu: 0xff67,
  Print: 0xff61,
  ScrollLock: 0xff14,
  Pause: 0xff13,
  NumLock: 0xff7f,
  KeypadEnter: 0xff8d,
  KeypadMultiply: 0xffaa,
  KeypadAdd: 0xffab,
  KeypadSubtract: 0xffad,
  KeypadDecimal: 0xffae,
  KeypadDivide: 0xffaf,
  Keypad0: 0xffb0,
  Keypad1: 0xffb1,
  Keypad2: 0xffb2,
  Keypad3: 0xffb3,
  Keypad4: 0xffb4,
  Keypad5: 0xffb5,
  Keypad6: 0xffb6,
  Keypad7: 0xffb7,
  Keypad8: 0xffb8,
  Keypad9: 0xffb9,
  Space: 0x20,
} as const

/**
 * The keysym for a character: Latin-1 characters are their code point, others the Unicode keysym
 * (0x1000000 + code point). `\n`, `\t` and `\b` map to Return, Tab and BackSpace.
 */
export function keysymFromChar(char: string): number {
  const cp = char.codePointAt(0)
  if (cp === undefined) throw new Error('keysymFromChar needs a character')
  if (cp === 0x0a || cp === 0x0d) return keysyms.Return
  if (cp === 0x09) return keysyms.Tab
  if (cp === 0x08) return keysyms.BackSpace
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp
  return 0x1000000 + cp
}
