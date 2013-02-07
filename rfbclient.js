var util = require('util'); // util.inherits
var net = require('net');

var EventEmitter = require('events').EventEmitter;
var PackStream = require('./unpackstream');

// constants
var rfb = require('./constants');
for (var key in rfb)
{
     module.exports[key] = rfb[key];
}

function RfbClient(stream, params)
{
    EventEmitter.call(this);
    this.params = params;
    var cli = this;
    cli.stream = stream;
    cli.pack_stream = new PackStream();
    cli.pack_stream.on('data', function( data ) {
        cli.stream.write(data);
    });
    stream.on('data', function( data ) {
        cli.pack_stream.write(data);
    });

    // TODO: check if I need that at all
    cli.pack_stream.serverBigEndian = !true;
    cli.pack_stream.clientBigEndian = !true;
    cli.readServerVersion();
}
util.inherits(RfbClient, EventEmitter);

PackStream.prototype.readString = function(strcb)
{
    var stream = this;
    stream.unpack('L', function(res) {
        stream.get(res[0], function(strBuff) {
            strcb(strBuff.toString());
        });
    });
}

RfbClient.prototype.end = function()
{
    this.stream.end();
}

RfbClient.prototype.readError = function()
{
    var cli = this;
    this.pack_stream.readString(function(str) {
         cli.emit('error', str);
    });
}

RfbClient.prototype.readServerVersion = function()
{
    var stream = this.pack_stream;
    var cli = this;
    stream.get(12, function(rfbver) {
        cli.serverVersion = rfbver.toString('ascii');
        stream.pack('a', [ rfb.versionstring.V3_008 ]).flush();
        if (cli.serverVersion == rfb.versionstring.V3_003)
        {
            stream.unpack('L', function(secType) {
                var type = secType[0];
                console.error('3.003 security type: ' + type);
                if (type == 0)
                {
                    cli.readError();
                } else {
                    cli.securityType = type;
                    // 3.003 version does not send result for None security
                    if (type == rfb.security.None)
                        cli.clientInit();
                    else
                        cli.processSecurity();
                }

            });
            return;
        }

        // read security types
        stream.unpack('C', function(res) {
            var numSecTypes = res[0];
            console.log(cli, numSecTypes);
            if (numSecTypes == 0) {
                console.error(['zero num sec types', res]);
                cli.readError();
            } else {

                stream.get(numSecTypes, function(secTypes) {
                    var securitySupported = [];
                    for (var s = 0; s < secTypes.length; ++s)
                        securitySupported[secTypes[s]] = true;
                    cli.params.security.forEach( function(clientSecurity) {
                        if (securitySupported[clientSecurity]) {
                            cli.securityType = clientSecurity;
                            stream.pack('C', [cli.securityType]).flush();
                            return cli.processSecurity();
                        }
                    });
                    throw new Error('Server does not support any security provided by client');
                });
            }
        });
   });
}

RfbClient.prototype.readSecurityResult = function()
{
    var stream = this.pack_stream;
    var cli = this;
    stream.unpack('L', function(securityResult) {
        if (securityResult[0] == 0)
        {
            cli.clientInit();
        } else {
            stream.readString(function(message) {
                console.error(message);
                process.exit(0);
            });
        }
    });
}

RfbClient.prototype.processSecurity = function()
{
    var stream = this.pack_stream;
    var cli = this;
    // TODO: refactor and move security to external file
    switch(cli.securityType) {
    case rfb.security.None:
        // do nothing
        cli.readSecurityResult();
        break;
    case rfb.security.VNC:
        var sendVncChallengeResponse = function(challenge, password) {
            var response = require('./d3des').response(challenge, cli.params.password);
            stream.pack('a', [response]).flush();
            cli.readSecurityResult();
        }
        stream.get(16, function(challenge) {
            if (cli.params.password)
                sendVncChallengeResponse(challenge, password);
            else if (cli.params.credentialsCallback) {
                cli.params.credentialsCallback.call(cli, function(password) {
                    sendVncChallengeResponse(challenge, password);
                });
            } else {
                throw new Error('Server requires VNC security but no password given');
            }
        });
        break;
    default:
        throw new Error('unknown security type: ' + cli.securityType);
    }
}

RfbClient.prototype.clientInit = function()
{
    var stream = this.pack_stream;
    var cli = this;

    var initMessage = cli.disconnectOthers ? rfb.connectionFlag.Exclusive : rfb.connectionFlag.Shared;
    stream.pack('C', [ initMessage ]).flush();

    stream.unpackTo(
        cli,
        [
        "S width",
        "S height",
        "C bpp", // 16-bytes pixel format
        "C depth",
        "C isBigEndian",
        "C isTrueColor",
        "S redMax",
        "S greenMax",
        "S blueMax",
        "C redShift",
        "C greenShift",
        "C blueShift",
        "xxx",
        "L titleLength"
        ],

        function() {


            // TODO: remove next 3 lines
            stream.serverBigEndian = false; //cli.isBigEndian;
            stream.clientBigEndian = false; //cli.isBigEndian;
            //stream.bigEndian = false; //cli.isBigEndian;

            stream.get(cli.titleLength, function(titleBuf) {
                cli.title = titleBuf.toString();
                delete cli.titleLength;
                cli.setPixelFormat();
            });
        }

    );
}

RfbClient.prototype.setPixelFormat = function()
{
    var stream = this.pack_stream;
    var cli = this;
    stream.pack('CxxxCCCCSSSCCCxxx',
        [0, cli.bpp, cli.depth, cli.isBigEndian, cli.isTrueColor, cli.redMax, cli.greenMax, cli.blueMax,
            cli.redShift, cli.greenShift, cli.blueShift]
    );
    stream.flush();
    cli.setEncodings();
}

function repeat(str, num)
{
    var res = '';
    for (var i=0; i < num; ++i)
        res += str;
    return res;
}

RfbClient.prototype.setEncodings = function()
{
    var stream = this.pack_stream;
    var cli = this;

    // build encodings list
    // TODO: API
    var encodings = cli.params.encodings || [rfb.encodings.raw, rfb.encodings.copyRect, rfb.encodings.pseudoDesktopSize, rfb.encodings.hextile];

    stream.pack('CxS', [rfb.clientMsgTypes.setEncodings, encodings.length]);
    stream.pack(repeat('l', encodings.length), encodings);
    stream.flush();

    cli.requestUpdate(false, 0, 0, cli.width, cli.height);
    cli.expectNewMessage();
    this.emit('connect');
}

RfbClient.prototype.expectNewMessage = function()
{
    var stream = this.pack_stream;
    var cli = this;
    stream.get(1, function(buff) {
        switch(buff[0]) {
        case rfb.serverMsgTypes.fbUpdate: cli.readFbUpdate(); break;
        case rfb.serverMsgTypes.setColorMap: cli.readColorMap(); break;
        case rfb.serverMsgTypes.bell: cli.readBell(); break;
        case rfb.serverMsgTypes.cutText: cli.readClipboardUpdate(); break;
        default:
            console.log('unsopported server message: ' + buff[0]);
        }
    });
}


var decodeHandlers = {
};

RfbClient.prototype.readFbUpdate = function()
{
    var stream = this.pack_stream;
    var cli = this;

    stream.unpack('xS', function(res) {
        var numRects = res[0];
        // decode each rectangle
        var numRectsLeft = numRects;
        function unpackRect() {
            if (numRectsLeft == 0)
            {
                cli.expectNewMessage();
                cli.requestUpdate(true, 0, 0, cli.width, cli.height);
                return;
            }
            numRectsLeft--;

            var rect = {};
            stream.unpackTo(rect,
                ['S x', 'S y', 'S width', 'S height', 'l encoding'],
                function() {

                    // TODO: rewrite using decodeHandlers
                    switch(rect.encoding) {
                    case rfb.encodings.raw:
                        cli.readRawRect(rect, unpackRect);
                        break;
                    case rfb.encodings.copyRect:
                        cli.readCopyRect(rect, unpackRect);
                        break;
                    case rfb.encodings.pseudoDesktopSize:
                        cli.width = rect.width;
                        cli.height = rect.height;
                        cli.emit('resize', rect);
                        unpackRect();
                        break;
                    case rfb.encodings.hextile:
                        cli.readHextile(rect, unpackRect);
                        break;
                    default:
                        console.log('unknown encoding!!! ' + rect.encoding);
                    }
                }
            );
        }
        unpackRect();
    });
}

RfbClient.prototype.readHextile = function(rect, cb)
{
    rect.emitter = new EventEmitter();
    rect.on = function(eventname, cb) {
        rect.emitter.on(eventname, cb);
    }
    rect.emit = function(eventname, param) {
        rect.emitter.emit(eventname, param);
    }

    rect.widthTiles = (rect.width >>> 4);
    rect.heightTiles = (rect.height >>> 4);
    rect.rightRectWidth = rect.width & 0x0f;
    rect.bottomRectHeight = rect.height & 0x0f;
    rect.tilex = 0;
    rect.tiley = 0;
    rect.tiles = [];
    this.emit('rect', rect);
    this.readHextileTile(rect, cb);
}

RfbClient.prototype.readHextileTile = function(rect, cb)
{
    var tile = {};
    var stream = this.pack_stream;
    var cli = this;

    tile.x = rect.tilex;
    tile.y = rect.tiley;
    tile.width = 16;
    if (tile.x == rect.widthTiles && rect.rightRectWidth > 0)
         tile.width = rect.rightRectWidt;
    tile.height = 16;
    if (tile.y == rect.heightTiles && rect.bottomRectHeight > 0)
         tile.height = rect.bottomRectHeight;

    // calculate next tilex & tiley and move up 'stack' if we at the last tile
    function nextTile()
    {
        rect.emit('tile', tile);
        tile = {};
        if (rect.tilex < rect.widthTiles)
        {
            rect.tilex++;
            return cli.readHextileTile(rect, cb);
        } else {
            rect.tilex = 0;
            if (rect.tiley < rect.heightTiles)
            {
                rect.tiley++;
                return cli.readHextileTile(rect, cb);
            } else {
                return cb();
            }
        }
    }

    var bytesPerPixel = cli.bpp >> 3;
    var tilebuflen = bytesPerPixel*tile.width*tile.height;
    stream.unpack('C', function(subEnc) {
        tile.subEncoding = subEnc[0];
        var hextile = rfb.subEncodings.hextile;
        if (tile.subEncoding & hextile.raw) {
            stream.get(tilebuflen, function(rawbuff)
            {
                tile.buffer = rawbuff;
                nextTile();
            });
            return;
        }
        tile.buffer = new Buffer(tilebuflen);

        function solidBackground() {
            // the whole tile is just single colored width x height
            for (var i=0; i < tilebuflen; i+= bytesPerPixel)
                tile.backgroundColor.copy(tile.buffer, i);
        }

        function readBackground() {
            if (tile.subEncoding & hextile.backgroundSpecified) {
                stream.get(bytesPerPixel, function(pixelValue)
                {
                    tile.backgroundColor = pixelValue;
                    rect.backgroundColor = pixelValue;
                    readForeground();
                });
            } else {
                tile.backgroundColor = rect.backgroundColor;
                readForeground();
            }
        }

        function readForeground() {
            // we should have background color set here
            solidBackground();
            if (rect.subEncoding & hextile.foregroundSpeciﬁed) {
                stream.get(bytesPerPixel, function(pixelValue)
                {
                    tile.foreroundColor = pixelValue;
                    rect.foreroundColor = pixelValue;
                    readSubrects();
                });
            } else {
                tile.foregroundColor = rect.foregroundColor;
                readSubrects();
            }
        }

        function readSubrects() {
            if (tile.subEncoding & hextile.anySubrects) {
                // read number of subrectangles
                stream.get('C', function(subrectsNum) {
                    tile.subrectsNum = subrectsNum[0];
                    readSubrect();
                });
            } else {
                nextTile();
            }
        }

        function drawRect(x, y, w, h)
        {
            console.log(tile);
            console.log(['drawRect', x, y, w, h, tile.foregroundColor]);
            // TODO: optimise
            for(var px = x; px < x+w; ++px)
            {
                for(var py = x; py < y+h; ++py)
                {
                    var offset = bytesPerPixel*(tile.width*py + px);
                    tile.foregroundColor.copy(tile.buffer, offset);
                }
            }
        }

        function readSubrect() {
            if (tile.subEncoding & hextile.subrectsColored) {
                // we have color + rect data
                stream.get(bytesPerPixel, function(pixelValue)
                {
                    tile.foreroundColor = pixelValue;
                    rect.foreroundColor = pixelValue;
                    readSubrectRect();
                });
            } else // we have just rect data
                readSubrectRect();
        }

        function readSubrectRect() {
            // read subrect x y w h encoded in two bytes
            stream.get(2, function(subrectRaw) {
                var x = (subrectRaw[0] & 0xf0) >> 4;
                var y = (subrectRaw[0] & 0x0f);
                var width  = (subrectRaw[1] & 0xf0) >> 4 + 1;
                var height = (subrectRaw[1] & 0x0f) + 1;
                drawRect(x, y, width, height);
                tile.subrectsNum--;

                if (tile.subrectsNum === 0)
                {
                    nextTile();
                } else
                    readSubrect();
            });
        }

        readBackground();
    });
}

RfbClient.prototype.readCopyRect = function(rect, cb)
{
    var stream = this.pack_stream;
    var cli = this;

    stream.unpack('SS', function(src) {
        rect.src = { x: src[0], y: src[1] };
        cli.emit('rect', rect);
        cb(rect);
    });
}

RfbClient.prototype.readRawRect = function(rect, cb)
{
    var stream = this.pack_stream;
    var cli = this;

    var bytesPerPixel = cli.bpp >> 3;
    stream.get(bytesPerPixel*rect.width*rect.height, function(rawbuff)
    {
        rect.buffer = rect.data = rawbuff;
        cli.emit('rect', rect);
        cb(rect);
    });
}

RfbClient.prototype.readColorMap = function()
{
}

RfbClient.prototype.readBell = function()
{
    this.emit('bell');
    this.expectNewMessage();
}

RfbClient.prototype.readClipboardUpdate = function()
{
    var stream = this.pack_stream;
    var cli = this;

    stream.unpack('xxxL', function(res) {
         stream.get(res[0], function(buf) {
             cli.emit('clipboard', buf.toString('ascii'));
             cli.expectNewMessage();
         })
    });
}

RfbClient.prototype.pointerEvent = function(x, y, buttons)
{
    var stream = this.pack_stream;

    stream.pack('CCSS', [rfb.clientMsgTypes.pointerEvent, buttons, x, y]);
    stream.flush();
}

RfbClient.prototype.keyEvent = function(keysym, isDown)
{
    var stream = this.pack_stream;

    stream.pack('CCxxL', [rfb.clientMsgTypes.keyEvent, isDown, keysym]);
    stream.flush();
}

RfbClient.prototype.requestUpdate = function(incremental, x, y, width, height)
{
    var stream = this.pack_stream;
    stream.pack('CCSSSS', [rfb.clientMsgTypes.fbUpdate, incremental, x, y, width, height]);
    stream.flush();
}

RfbClient.prototype.updateClipboard = function(text) {
    var stream = this.pack_stream;
    stream.pack('CxxxSa', [rfb.clientMsgTypes.cutText, text.length, text]);
    stream.flush;
}

// TODO: move out of rfbclient
var fs = require('fs');
function createRfbStream(name)
{
    var stream = new EventEmitter();
    var fileStream = fs.createReadStream(name);
    var pack = new PackStream();
    fileStream.pipe(pack);
    var start = Date.now();
    function readData()
    {
        fileStream.resume();
        pack.unpack('L', function(size) {
            pack.get(size[0], function(databuf) {
                pack.unpack('L', function(timestamp) {
                    var padding = 3 - ((size - 1) & 0x03);
                    pack.get(padding, function() {
                        if (!stream.ending) {
                            stream.emit('data', databuf);
                            var now = Date.now() - start;
                            var timediff = timestamp[0] - now;
                            stream.timeout = setTimeout(readData, timediff);
                            fileStream.pause();
                        }
                    });
                });
            });
        });
    }

    pack.get(12, function(fileVersion) {
         readData();
    });

    stream.end = function() {
        stream.ending = true;
        if (stream.timeout)
            clearTimeout(stream.timeout);
    };

    stream.write = function(buf) {
        // ignore
    }
    return stream;
}

function createConnection(params)
{
    // first matched to list of supported by server will be used
    if (!params.security)
        params.security = [rfb.security.VNC, rfb.security.None];

    var stream;
    if (!params.stream) {
        if (params.in)
            stream = createRfbStream(params.rfbfile);
        else {
            if (!params.host)
                params.host = '127.0.0.1';
            if (!params.port)
                params.port = 5900;
            stream = net.createConnection(params.port, params.host);
        }
    } else {
        stream = params.stream;
    }

    // todo: move outside rfbclient
    if (params.out)
    {
        var start = Date.now();
        var wstream = fs.createWriteStream(params.out);
        wstream.write('FBS 001.001\n');
        stream.on('data', function(data) {
            var sizeBuf = Buffer(4);
            var timeBuf = Buffer(4);
            var size = data.length;
            sizeBuf.writeInt32BE(size, 0);
            wstream.write(sizeBuf);
            wstream.write(data);
            timeBuf.writeInt32BE(Date.now() - start, 0);
            wstream.write(timeBuf);
            var padding = 3 - ((size - 1) & 0x03);
            var pbuf = Buffer(padding);
            wstream.write(pbuf);
        }).on('end', function() {
            wstream.end();
        });
    }

    return new RfbClient(stream, params);
}
exports.createConnection = createConnection;
