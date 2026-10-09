// Follows the screen with back-pressure and types into it.
//   node examples/watch.ts [host] [port] [password]

import { buttons, connect, encodings, Framebuffer, keysymFromChar, keysyms } from '../src/index.ts'

const [host = '127.0.0.1', port = '5900', password] = process.argv.slice(2)
const client = await connect({
  host,
  port: Number(port),
  password,
  initialUpdate: false,
  // The defaults plus the cursor shape: the server stops drawing the pointer into the framebuffer.
  encodings: [
    encodings.zrle,
    encodings.tight,
    encodings.hextile,
    encodings.raw,
    encodings.pseudoCursor,
    encodings.pseudoDesktopSize,
    encodings.pseudoExtendedDesktopSize,
    encodings.pseudoLastRect,
  ],
})
console.log(`connected to "${client.name}", ${client.width}×${client.height}`)
client.on('resize', ({ width, height }) => console.log(`resized to ${width}×${height}`))
client.on('cursor', (c) => console.log(`cursor ${c.width}×${c.height}, hotspot ${c.x},${c.y}`))
client.on('clipboard', (text) => console.log(`clipboard: ${JSON.stringify(text)}`))
client.on('close', () => console.log('closed'))

const fb = Framebuffer.attach(client)
setTimeout(() => {
  // Click in the middle and type a line.
  client.pointerEvent(fb.width >> 1, fb.height >> 1, buttons.left)
  client.pointerEvent(fb.width >> 1, fb.height >> 1, 0)
  for (const ch of 'hello from rfb2') {
    client.keyEvent(keysymFromChar(ch), true)
    client.keyEvent(keysymFromChar(ch), false)
  }
  client.keyEvent(keysyms.Return, true)
  client.keyEvent(keysyms.Return, false)
}, 1000)
setTimeout(() => client.close(), 5000)

// The next update is requested only after this loop body has run.
for await (const update of client.updates()) {
  const pixels = update.rects.filter((r) => r.type === 'pixels' || r.type === 'copy').length
  console.log(`update: ${update.rects.length} rects (${pixels} with pixels)`)
}
