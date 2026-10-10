/*
 * rfb2-clipboard: makes clipboard text sent by one VNC client reach the other clients
 * (docker/README.md, "Clipboard").
 *
 *   DISPLAY=:1 rfb2-clipboard &
 *
 * A VNC server puts a ClientCutText into the X selections (TigerVNC, TurboVNC and x11vnc own
 * PRIMARY and CLIPBOARD) or into CUT_BUFFER0 (TightVNC 1.3). It only tells its VNC clients about
 * changes made by other X clients, and in these sessions no other X client runs. So this one:
 *   - whenever another client takes PRIMARY or CLIPBOARD (XFIXES selection notify), fetches the
 *     text (UTF8_STRING, else STRING) and takes the selection over, serving TARGETS, UTF8_STRING,
 *     STRING and TEXT; the server sees the new owner and announces the text to its clients;
 *   - whenever CUT_BUFFER0 changes to a new value, writes the same value back, as a client.
 * It never maps a window, so it draws nothing. Text only, up to 16 MB, no INCR transfers.
 * (autocutsel does not do this: it copies a selection into the cut buffer, but only takes a
 * selection over when the cut buffer changes.)
 */
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/extensions/Xfixes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static Display *dpy;
static Window root, win;
static Atom aClipboard, aUtf8, aText, aTargets, aIncr;

struct sel {
  Atom atom, prop;
  unsigned char *data;
  unsigned long len;
} sels[2];

static unsigned char *cut;
static unsigned long cutlen;

static struct sel *find(Atom a) {
  for (int i = 0; i < 2; i++)
    if (sels[i].atom == a) return &sels[i];
  return NULL;
}

static unsigned char *copy(const unsigned char *data, unsigned long len) {
  unsigned char *p = malloc(len + 1);
  if (!p) {
    fprintf(stderr, "rfb2-clipboard: out of memory\n");
    exit(1);
  }
  memcpy(p, data, len);
  p[len] = 0;
  return p;
}

static void serve(XSelectionRequestEvent *rq) {
  XSelectionEvent ev = {.type = SelectionNotify,
                        .display = rq->display,
                        .requestor = rq->requestor,
                        .selection = rq->selection,
                        .target = rq->target,
                        .property = None,
                        .time = rq->time};
  struct sel *s = find(rq->selection);
  Atom prop = rq->property != None ? rq->property : rq->target;
  if (s && s->data) {
    if (rq->target == aTargets) {
      Atom targets[] = {aTargets, aUtf8, XA_STRING, aText};
      XChangeProperty(dpy, rq->requestor, prop, XA_ATOM, 32, PropModeReplace, (unsigned char *)targets, 4);
      ev.property = prop;
    } else if (rq->target == aUtf8 || rq->target == XA_STRING || rq->target == aText) {
      XChangeProperty(dpy, rq->requestor, prop, rq->target == aText ? aUtf8 : rq->target, 8, PropModeReplace,
                      s->data, (int)s->len);
      ev.property = prop;
    }
  }
  XSendEvent(dpy, rq->requestor, False, 0, (XEvent *)&ev);
}

static void received(XSelectionEvent *ev) {
  struct sel *s = find(ev->selection);
  if (!s) return;
  if (ev->property == None) {
    if (ev->target == aUtf8) XConvertSelection(dpy, s->atom, XA_STRING, s->prop, win, ev->time);
    return;
  }
  Atom type;
  int format;
  unsigned long n, after;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy, win, s->prop, 0, 1 << 22, True, AnyPropertyType, &type, &format, &n, &after,
                         &data) != Success)
    return;
  if (type == aIncr || format != 8) {
    fprintf(stderr, "rfb2-clipboard: ignoring a non-text or INCR selection\n");
  } else {
    free(s->data);
    s->data = copy(data, n);
    s->len = n;
    XSetSelectionOwner(dpy, s->atom, win, CurrentTime);
    if (XGetSelectionOwner(dpy, s->atom) == win)
      printf("rfb2-clipboard: took over %s (%lu bytes)\n", s->atom == XA_PRIMARY ? "PRIMARY" : "CLIPBOARD", n);
    fflush(stdout);
  }
  if (data) XFree(data);
}

static void cutbuffer(void) {
  Atom type;
  int format;
  unsigned long n, after;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy, root, XA_CUT_BUFFER0, 0, 1 << 22, False, AnyPropertyType, &type, &format, &n,
                         &after, &data) != Success)
    return;
  if (data && format == 8 && n > 0 && (n != cutlen || memcmp(data, cut, n) != 0)) {
    free(cut);
    cut = copy(data, n);
    cutlen = n;
    XChangeProperty(dpy, root, XA_CUT_BUFFER0, type, 8, PropModeReplace, cut, (int)cutlen);
    printf("rfb2-clipboard: rewrote CUT_BUFFER0 (%lu bytes)\n", n);
    fflush(stdout);
  }
  if (data) XFree(data);
}

int main(void) {
  dpy = XOpenDisplay(NULL);
  if (!dpy) {
    fprintf(stderr, "rfb2-clipboard: cannot open $DISPLAY\n");
    return 1;
  }
  int fixesEvent, fixesError;
  if (!XFixesQueryExtension(dpy, &fixesEvent, &fixesError)) {
    fprintf(stderr, "rfb2-clipboard: no XFIXES extension\n");
    return 1;
  }
  root = DefaultRootWindow(dpy);
  win = XCreateSimpleWindow(dpy, root, 0, 0, 1, 1, 0, 0, 0); /* never mapped */
  aClipboard = XInternAtom(dpy, "CLIPBOARD", False);
  aUtf8 = XInternAtom(dpy, "UTF8_STRING", False);
  aText = XInternAtom(dpy, "TEXT", False);
  aTargets = XInternAtom(dpy, "TARGETS", False);
  aIncr = XInternAtom(dpy, "INCR", False);
  sels[0] = (struct sel){.atom = XA_PRIMARY, .prop = XInternAtom(dpy, "RFB2_PRIMARY", False)};
  sels[1] = (struct sel){.atom = aClipboard, .prop = XInternAtom(dpy, "RFB2_CLIPBOARD", False)};
  for (int i = 0; i < 2; i++) XFixesSelectSelectionInput(dpy, root, sels[i].atom, XFixesSetSelectionOwnerNotifyMask);
  XSelectInput(dpy, root, PropertyChangeMask);

  for (;;) {
    XEvent ev;
    XNextEvent(dpy, &ev);
    if (ev.type == fixesEvent + XFixesSelectionNotify) {
      XFixesSelectionNotifyEvent *sn = (XFixesSelectionNotifyEvent *)&ev;
      struct sel *s = find(sn->selection);
      if (s && sn->owner != None && sn->owner != win)
        XConvertSelection(dpy, s->atom, aUtf8, s->prop, win, sn->selection_timestamp);
    } else if (ev.type == SelectionNotify) {
      received(&ev.xselection);
    } else if (ev.type == SelectionRequest) {
      serve(&ev.xselectionrequest);
    } else if (ev.type == PropertyNotify && ev.xproperty.window == root &&
               ev.xproperty.atom == XA_CUT_BUFFER0 && ev.xproperty.state == PropertyNewValue) {
      cutbuffer();
    }
    XFlush(dpy);
  }
}
