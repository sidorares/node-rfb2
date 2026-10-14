/*
 * rfb2-xsetup: makes an X server's screen a static, deterministic test card (docker/README.md).
 *
 *   rfb2-xsetup testcard.ppm cursor.xbm cursor-mask.xbm
 *
 * On $DISPLAY it:
 *   - sets the root window background to the binary PPM (P6) image, drawn 1:1 from the top-left;
 *   - sets the root window cursor from the XBM pair (hotspot from cursor.xbm; foreground
 *     rgb(20,40,160), background rgb(255,230,80), as in docker/assets/make-testcard.mjs);
 *   - parks the pointer at (0,0): the cursor's hotspot is its bottom-right pixel, which is
 *     transparent, so a cursor drawn into the framebuffer by the VNC server changes no pixel;
 *   - turns off the screen saver and DPMS, so the screen never blanks.
 * It exits with close-down mode RetainPermanent: an X server resets (black root, default cursor,
 * pointer in the middle) when its last client disconnects, unless that client's resources are
 * retained. The servers are also started with -noreset where they have it. No window manager runs.
 */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/dpms.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *msg) {
  fprintf(stderr, "rfb2-xsetup: %s\n", msg);
  exit(1);
}

static int shift_of(unsigned long mask) {
  int s = 0;
  if (!mask) return 0;
  while (!(mask & 1)) {
    mask >>= 1;
    s++;
  }
  return s;
}

static int ppm_int(FILE *f) {
  int c, v = 0;
  do {
    c = fgetc(f);
    if (c == '#')
      while (c != '\n' && c != EOF) c = fgetc(f);
  } while (c == ' ' || c == '\t' || c == '\n' || c == '\r');
  if (c < '0' || c > '9') die("bad PPM header");
  while (c >= '0' && c <= '9') {
    v = v * 10 + (c - '0');
    c = fgetc(f);
  }
  return v; /* the single whitespace byte after the value is consumed */
}

int main(int argc, char **argv) {
  if (argc != 4) die("usage: rfb2-xsetup testcard.ppm cursor.xbm cursor-mask.xbm");

  Display *dpy = XOpenDisplay(NULL);
  if (!dpy) die("cannot open $DISPLAY");
  int scr = DefaultScreen(dpy);
  Window root = RootWindow(dpy, scr);
  Visual *vis = DefaultVisual(dpy, scr);
  int depth = DefaultDepth(dpy, scr);
  int sw = DisplayWidth(dpy, scr), sh = DisplayHeight(dpy, scr);
  if (vis->class != TrueColor) die("default visual is not TrueColor");

  /* Background image */
  FILE *f = fopen(argv[1], "rb");
  if (!f) die("cannot open the PPM");
  if (fgetc(f) != 'P' || fgetc(f) != '6') die("not a binary PPM (P6)");
  int w = ppm_int(f), h = ppm_int(f), maxval = ppm_int(f);
  if (maxval != 255) die("PPM maxval must be 255");
  unsigned char *rgb = malloc((size_t)w * h * 3);
  if (!rgb || fread(rgb, 3, (size_t)w * h, f) != (size_t)w * h) die("short PPM");
  fclose(f);

  XImage *img = XCreateImage(dpy, vis, depth, ZPixmap, 0, NULL, w, h, 32, 0);
  if (!img) die("XCreateImage failed");
  img->data = malloc((size_t)img->bytes_per_line * h);
  if (!img->data) die("out of memory");
  int rs = shift_of(vis->red_mask), gs = shift_of(vis->green_mask), bs = shift_of(vis->blue_mask);
  int rbits = 0, gbits = 0, bbits = 0;
  for (unsigned long m = vis->red_mask >> rs; m & 1; m >>= 1) rbits++;
  for (unsigned long m = vis->green_mask >> gs; m & 1; m >>= 1) gbits++;
  for (unsigned long m = vis->blue_mask >> bs; m & 1; m >>= 1) bbits++;
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      const unsigned char *p = rgb + ((size_t)y * w + x) * 3;
      unsigned long px = ((unsigned long)(p[0] >> (8 - rbits)) << rs) |
                         ((unsigned long)(p[1] >> (8 - gbits)) << gs) |
                         ((unsigned long)(p[2] >> (8 - bbits)) << bs);
      XPutPixel(img, x, y, px);
    }

  Pixmap pm = XCreatePixmap(dpy, root, sw, sh, depth);
  GC gc = XCreateGC(dpy, pm, 0, NULL);
  XSetForeground(dpy, gc, BlackPixel(dpy, scr));
  XFillRectangle(dpy, pm, gc, 0, 0, sw, sh);
  XPutImage(dpy, pm, gc, img, 0, 0, 0, 0, w < sw ? w : sw, h < sh ? h : sh);
  XSetWindowBackgroundPixmap(dpy, root, pm);
  XClearWindow(dpy, root);
  XFreePixmap(dpy, pm); /* the window keeps its own reference */
  XFreeGC(dpy, gc);

  /* Cursor */
  unsigned int cw, ch, mw, mh;
  int xhot = 0, yhot = 0, mx, my;
  Pixmap src, mask;
  if (XReadBitmapFile(dpy, root, argv[2], &cw, &ch, &src, &xhot, &yhot) != BitmapSuccess)
    die("cannot read the cursor bitmap");
  if (XReadBitmapFile(dpy, root, argv[3], &mw, &mh, &mask, &mx, &my) != BitmapSuccess)
    die("cannot read the cursor mask");
  if (cw != mw || ch != mh) die("cursor and mask sizes differ");
  if (xhot < 0) xhot = 0;
  if (yhot < 0) yhot = 0;
  XColor fg = {.red = 20 * 257, .green = 40 * 257, .blue = 160 * 257, .flags = DoRed | DoGreen | DoBlue};
  XColor bg = {.red = 255 * 257, .green = 230 * 257, .blue = 80 * 257, .flags = DoRed | DoGreen | DoBlue};
  Cursor cur = XCreatePixmapCursor(dpy, src, mask, &fg, &bg, xhot, yhot);
  XDefineCursor(dpy, root, cur);
  XFreeCursor(dpy, cur);
  XFreePixmap(dpy, src);
  XFreePixmap(dpy, mask);

  XWarpPointer(dpy, None, root, 0, 0, 0, 0, 0, 0);

  /* Never blank */
  XSetScreenSaver(dpy, 0, 0, DontPreferBlanking, DontAllowExposures);
  int ev, er;
  if (DPMSQueryExtension(dpy, &ev, &er) && DPMSCapable(dpy)) {
    DPMSSetTimeouts(dpy, 0, 0, 0);
    DPMSDisable(dpy);
  }

  XSync(dpy, False);
  Window r, c;
  int rx, ry, wx, wy;
  unsigned int keys;
  XQueryPointer(dpy, root, &r, &c, &rx, &ry, &wx, &wy, &keys);
  XSetCloseDownMode(dpy, RetainPermanent);
  printf("rfb2-xsetup: %dx%d depth %d, image %dx%d, cursor %ux%u hot %d,%d, pointer %d,%d\n", sw, sh,
         depth, w, h, cw, ch, xhot, yhot, rx, ry);
  XCloseDisplay(dpy);
  return 0;
}
