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
};

r.pointerEvent(100, 100, 0); // x, y, button state (bit mask for each mouse button)
r.keyEvent(40, 0);           // keycode, is down?
r.clipboardUpdate('send text to remote clipboard');

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
}

r.on('clipboard', function(newPasteBufData) {
  console.log('remote clipboard updated!', newPasteBufData);
});

r.on('bell' console.log.bind(null, 'Bell!!'));

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
  - Hextile, encoding support
  - Server side protocol

TODO:
  - ZRle, RRE, CoRRE, Zlib, Tight encodings
  - ARD and MS security types

# see also:
  https://github.com/substack/node-rfb

# preformance
  ( TODO: benchmark )


[![Bitdeli Badge](https://d2weczhvl823v0.cloudfront.net/sidorares/node-rfb2/trend.png)](https://bitdeli.com/free "Bitdeli Badge")

