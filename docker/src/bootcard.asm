; bootcard: a boot sector that draws a static, deterministic 80x25 VGA text test card and halts.
; The QEMU test servers boot it from a floppy image (docker/README.md):
;
;   nasm -f bin -o bootcard.bin bootcard.asm      (512 bytes; padded to a 1.44 MB floppy image)
;
;   row  0      title, bright white on blue
;   row  1      plain text, light grey on black
;   rows 2-17   every attribute: row = background 0-15, 16 cells of 5 characters = foreground
;               0-15; each cell is full block, the three shades and a letter (A-P = foreground)
;   rows 18-21  all 256 code page 437 glyphs, bright green on black, then a line of single
;               box-drawing characters
;   rows 22-24  a double-line box with text (yellow on black) next to a solid 40x3 red area
;
; The text cursor is hidden (cursor start register bit 5) and attribute bit 7 selects a bright
; background instead of blinking, so nothing on the screen changes over time. When done it writes
; "rfb2-bootcard ready" to the debug port 0x402 (SeaBIOS's debug console) and halts for good.

bits 16
org 0x7c00

start:
  cli
  xor ax, ax
  mov ds, ax
  mov ss, ax
  mov sp, 0x7c00
  sti
  cld

  mov ax, 0x0003          ; 80x25 colour text mode (clears the screen)
  int 0x10
  mov ah, 0x01            ; cursor shape: CH bit 5 set = no cursor
  mov cx, 0x2000
  int 0x10
  mov ax, 0x1003          ; attribute bit 7: bright background, not blink
  xor bx, bx
  int 0x10

  mov ax, 0xb800
  mov es, ax
  xor di, di

  mov ah, 0x1f            ; row 0
  mov si, title
  call line
  mov ah, 0x07            ; row 1
  mov si, text
  call line

  xor dl, dl              ; rows 2-17: DL = background, DH = foreground
.grid_row:
  xor dh, dh
.grid_cell:
  mov ah, dl
  shl ah, 4
  or ah, dh
  mov al, 0xdb
  stosw
  mov al, 0xb2
  stosw
  mov al, 0xb1
  stosw
  mov al, 0xb0
  stosw
  mov al, 'A'
  add al, dh
  stosw
  inc dh
  cmp dh, 16
  jb .grid_cell
  inc dl
  cmp dl, 16
  jb .grid_row

  mov ah, 0x0a            ; rows 18-21: glyphs 0-255
  xor al, al
.glyph:
  stosw
  inc al
  jnz .glyph
  mov ax, 0x0bc4          ; rest of row 21: single horizontal lines
  mov cx, 64
  rep stosw

  mov ax, 0x0ec9          ; row 22
  stosw
  mov al, 0xcd
  mov cx, 38
  rep stosw
  mov al, 0xbb
  stosw
  call red40
  mov al, 0xba            ; row 23
  stosw
  mov si, boxtext
  call puts
  mov al, 0xba
  stosw
  call red40
  mov al, 0xc8            ; row 24
  stosw
  mov al, 0xcd
  mov cx, 38
  rep stosw
  mov al, 0xbc
  stosw
  call red40

  mov si, ready           ; tell the start script the screen is final
  mov dx, 0x402
.ready:
  lodsb
  test al, al
  jz halt
  out dx, al
  jmp .ready

halt:
  cli
  hlt
  jmp halt

; puts: copy the NUL-terminated string at DS:SI to ES:DI with attribute AH
puts:
  lodsb
  test al, al
  jz .done
  stosw
  jmp puts
.done:
  ret

; line: puts, then pad with spaces to the end of the 80-column row
line:
  call puts
  mov al, ' '
.pad:
  push ax
  mov ax, di
  xor dx, dx
  mov cx, 160
  div cx
  pop ax
  test dx, dx
  jz .done
  stosw
  jmp .pad
.done:
  ret

; red40: 40 spaces, bright red on red (a solid red area); keeps AX
red40:
  push ax
  mov ax, 0x4c20
  mov cx, 40
  rep stosw
  pop ax
  ret

title:   db 'RFB2 TEST CARD - QEMU VGA TEXT 80x25 (720x400, 9x16 CELLS)', 0
text:    db 'The quick brown fox jumps over the lazy dog. 0123456789 !"#$%&()*+,-./:;<=>?@[]', 0
boxtext: db ' Static screen: no cursor, no blink.'
         times 38 - ($ - boxtext) db ' '   ; exactly 38 columns inside the box
         db 0
ready:   db 'rfb2-bootcard ready', 10, 0

times 510 - ($ - $$) db 0
dw 0xaa55
