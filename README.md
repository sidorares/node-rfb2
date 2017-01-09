node-rfb2
=========

[RFB](http://en.wikipedia.org/wiki/RFB_protocol) wire protocol client and server

```js
var rfb = require('rfb2');
var r = rfb.createConnection({
  host: '127.0.0.1',
  port: 5900,
  password: 'secret'
});

r.on('connect', function() {
  console.log('successfully connected and authorised');
  console.log('remote screen name: ' + r.title + ' width:' + r.width + ' height: ' + r.height);
});

r.on('error', function(error) {
  throw new Error(error);
});

r.pointerEvent(100, 100, 0); // x, y, button state (bit mask for each mouse button)
r.keyEvent(40, 0);           // keycode, is down?
r.updateClipboard('send text to remote clipboard');

// screen updates
r.on('rect', function(rect) {
   switch(rect.encoding) {
   rfb.encodings.raw:
      // rect.x, rect.y, rect.width, rect.height, rect.data
      // pixmap format is in r.bpp, r.depth, r.redMask, greenMask, blueMask, redShift, greenShift, blueShift
   rfb.encodings.copyRect:
      // pseudo-rectangle
      // copy rectangle from rect.src.x, rect.src.y, rect.width, rect.height, to rect.x, rect.y
   rfb.encodings.hextile:
      // not fully implemented
      rect.on('tile', handleHextileTile); // emitted for each subtile
   }
});

r.on('resize', function(rect) {
  console.log('window size has been resized! Width: %s, Height: %s', rect.width, rect.height);
});

r.on('clipboard', function(newPasteBufData) {
  console.log('remote clipboard updated!', newPasteBufData);
});

r.on('bell', console.log.bind(null, 'Bell!!'));

// force update
// updates are requested automatically after each new received update
// you may want to have more frequent updates for high latency / high bandwith connection
r.requestUpdate(false, 0, 0, r.width, r.height); // incremental?, x, y, w, h

r.end(); // close connection

```

# Status:

Ready
  - pointer, keyboard, cutText, requestUpdate client messages
  - colormap, bell, cutText server messages
  - Raw FB update encoding
  - pseudoDesktopSize and copyRect pseudo rect updates
  - record/replay to/from file

In progress:
  - Hextile encoding support
  - Server side protocol

TODO:
  - ZRle, RRE, CoRRE, Zlib, Tight encodings
  - ARD and MS security types
  - VNC server with [x11](https://github.com/sidorares/node-x11) and COMPOSITE/DAMAGE extensions

# see also:
  - [node-rfb](https://github.com/substack/node-rfb) - Substack's implementation of rfb protocol.
  - [VNC client on 200 lines of JavaScript](http://blog.mgechev.com/2013/08/30/vnc-javascript-nodejs/) - blog post and [HTML5 client](https://github.com/mgechev/js-vnc-demo-project) using node-rfb2
  - [Vnc-over-gif](https://github.com/sidorares/vnc-over-gif) - vnc to gif proxy server. Stream your screen to animated gif image!
  - [rfbrecord](https://github.com/sidorares/rfbrecord) - stream VNC connection to video file
  - [ANSI-vnc](https://npmjs.org/package/ansi-vnc) - terminal vnc client.
  - [node-vnc](https://github.com/sidorares/node-vnc) - graphical vnc client for X Window graphics using [node X11 client](https://github.com/sidorares/node-x11).
  - [vnc.js](https://github.com/bgaff/vnc.js) - LinkedIn intern [hackday 2011 project](http://engineering.linkedin.com/javascript/vncjs-how-build-javascript-vnc-client-24-hour-hackday)
  - [rdpy](https://github.com/citronneur/rdpy) - rfb and rdp implementation in python


[![Bitdeli Badge](https://d2weczhvl823v0.cloudfront.net/sidorares/node-rfb2/trend.png)](https://bitdeli.com/free "Bitdeli Badge")
