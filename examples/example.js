var rfb = require('..');
var r = rfb.createConnection({
  host: '127.0.0.1',
  port: 5900,
  password: 'secret'
});

r.on('connect', function() {
  console.log('successfully connected and authorised');
  console.log('remote screen name: ' + r.title + ' width:' + r.width + ' height: ' + r.height);
});

// do this only when connected
//r.updateClipboard('send text to remote clipboard');

// screen updates
r.on('rect', function(rect) {
   switch(rect.encoding) {
   case rfb.encodings.raw:
      // rect.x, rect.y, rect.width, rect.height, rect.data
      // pixmap format is in r.bpp, r.depth, r.redMask, greenMask, blueMask, redShift, greenShift, blueShift
   case rfb.encodings.copyRect:
      // pseudo-rectangle
      // copy rectangle from rect.src.x, rect.src.y, rect.width, rect.height, to rect.x, rect.y
   case rfb.encodings.hextile:
      // not fully implemented
      //rect.on('tile', handleHextileTile); // emitted for each subtile
   }
});

r.on('clipboard', function(newPasteBufData) {
  console.log('remote clipboard updated!', newPasteBufData);
});
r.on('bell', console.log.bind(null, 'Bell!!'));
