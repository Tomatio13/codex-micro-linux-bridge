import { EventEmitter } from "node:events";

/**
 * Transparently forwards fixed-size HID reports between two transports.
 *
 * Used for real hardware: ChatGPT owns one side through the shim/helper, while
 * the physical Codex Micro owns the other through Linux hidraw. The device's
 * firmware remains the only JSON-RPC endpoint.
 */
export class RawBridge extends EventEmitter {
  constructor(hostTransport, deviceTransport) {
    super();
    this.hostTransport = hostTransport;
    this.deviceTransport = deviceTransport;
    this._toDevice = (report) => this._forward(deviceTransport, report, "physical device");
    this._toHost = (report) => this._forward(hostTransport, report, "host transport");
    hostTransport.on("report", this._toDevice);
    deviceTransport.on("report", this._toHost);
  }

  _forward(target, report, targetName) {
    try {
      target.write(report);
    } catch (err) {
      this.emit("error", new Error(`Could not forward HID report to ${targetName}: ${err.message}`));
    }
  }

  dispose() {
    this.hostTransport.off?.("report", this._toDevice);
    this.deviceTransport.off?.("report", this._toHost);
  }
}
