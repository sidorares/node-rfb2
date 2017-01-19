var rfb = require('..');
var r = rfb.createConnection({
    host: '127.0.0.1',
    port: 5921,
    password: '',
    //encodings: [rfb.encodings.raw],
    encodings: [rfb.encodings.tightPng, rfb.encodings.raw],
});

r.on('connect', function() {
    console.log('successfully connected and authorised');
    console.log('remote screen name: ' + r.title + ' width:' + r.width + ' height: ' + r.height);
    //r.updateClipboard('send text to remote clipboard');
    //r.requestUpdate(false, 0, 0, r.width, r.height); // incremental?, x, y, w, h
});

// screen updates
r.on('rect', function(rect) {
    switch(rect.encoding) {
        case rfb.encodings.raw:
            console.log('raw frame recieved');
            // rect.x, rect.y, rect.width, rect.height, rect.data
            // pixmap format is in r.bpp, r.depth, r.redMask, greenMask, blueMask, redShift, greenShift, blueShift
            console.log('rect.x ' + rect.x + ' rect.y ' +  rect.y + ' rect.width ' + rect.width + ' rect.height ' + rect.height);
            r.end()
            break;
        case rfb.encodings.tight:
        case rfb.encodings.tightPng:
            console.log('tight frame recieved');
            console.log('rect.x ' + rect.x + ' rect.y ' +  rect.y + ' rect.width ' + rect.width + ' rect.height ' + rect.height + ' rect.cmode ' + rect.cmode);
//            if (rect.cmode == 'png') {
//                var fs = require('fs');
//                fs.writeFile('/home/vtolstov/devel/test' + Date.now() + '.png', rect.data, function(err) {
//                    if(err) {
//                        return console.log(err);
//                    }
//                }); 
//            }
//            r.end()
            break;
        case rfb.encodings.copyRect:
            // pseudo-rectangle
            // copy rectangle from rect.src.x, rect.src.y, rect.width, rect.height, to rect.x, rect.y
            break;
        case rfb.encodings.hextile:
            // not fully implemented
            //rect.on('tile', handleHextileTile); // emitted for each subtile
            break;
    }
});

//r.on('clipboard', function(newPasteBufData) {
//  console.log('remote clipboard updated!', newPasteBufData);
//});
//r.on('bell', console.log.bind(null, 'Bell!!'));
// force update
// // updates are requested automatically after each new received update
// // you may want to have more frequent updates for high latency / high bandwith connection
//r.requestUpdate(false, 0, 0, r.width, r.height); // incremental?, x, y, w, h
//
//r.end(); // close connection

