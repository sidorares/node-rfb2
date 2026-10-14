// The 0.x API still works, from CommonJS too (require() of the ES module needs Node 22.12+).
//   npm run build && node examples/legacy.cjs [host] [port] [password]

const rfb = require('..')

const [host = '127.0.0.1', port = '5900', password] = process.argv.slice(2)
const r = rfb.createConnection({ host, port: Number(port), password })

r.on('connect', () => {
  console.log(`remote screen name: ${r.title} width: ${r.width} height: ${r.height}`)
  r.updateClipboard('send text to remote clipboard')
})
r.on('rect', (rect) => {
  switch (rect.encoding) {
    case rfb.encodings.raw:
      // rect.x, rect.y, rect.width, rect.height, rect.data (pixels in r.pixelFormat; bgrx by default)
      console.log(`raw ${rect.width}×${rect.height} at ${rect.x},${rect.y}`)
      break
    case rfb.encodings.copyRect:
      console.log(`copy ${rect.width}×${rect.height} from ${rect.src.x},${rect.src.y} to ${rect.x},${rect.y}`)
      break
    default:
      // Every other pixel encoding (Hextile, ZRLE, Tight, ...) is decoded: rect.type === 'pixels'.
      console.log(`${rect.type} rect, encoding ${rect.encoding}`)
  }
})
r.on('error', (err) => console.error(err.code, err.message))
setTimeout(() => r.end(), 3000)
