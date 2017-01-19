import * as events from "events";

export enum encodings {
  raw = 0,
  copyRect = 1,
  rre = 2,
  hextile = 5,
  zrle = 16,
  pseudoCursor = -239,
  pseudoDesktopSize = -223,
  tight = 7,
  tightPng = -260
}

export enum security {
  None = 1,
  VNC = 2,
  ARD = 30
}

interface RfbClientArgs {
  host?: string,
  port?: number,
  password?: string,
  security?: Array<security>,
  credentialsCallback?(cli: RfbClient, callback: (password: string) => void): void,
  encodings?: Array<encodings>
}

export class RfbClient extends events.EventEmitter {
  width: number;
  height: number;

  requestUpdate(incremental: boolean, x: number, y: number, width: number, height: number): void;
  end(): void;
}

export function createConnection(args: RfbClientArgs): RfbClient;
