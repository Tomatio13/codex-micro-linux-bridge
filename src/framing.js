// HID report framing for Work Louder / Codex Micro devices.
//
// Every logical message travels as one or more 64-byte HID reports:
//
//   byte 0 : 0x06        report ID
//   byte 1 : channel     1 = debug log, 2 = RPC
//   byte 2 : length      number of payload bytes in this report (0..61)
//   3..63  : payload     up to 61 UTF-8 bytes; longer messages span reports
//
// The receiver concatenates payloads per channel until it sees a newline,
// then hands the complete line to the RPC layer. This mirrors the framing in
// @worklouder/wl-device-kit's WLDeviceCommImpl exactly, so the ChatGPT app's
// bridge cannot tell us apart from real firmware.

export const REPORT_ID = 0x06;
export const REPORT_SIZE = 64; // report ID + 63 data bytes
export const MAX_PAYLOAD = 61; // 64 - (reportID + channel + length)

export const Channel = Object.freeze({
  DEBUG: 1,
  RPC: 2,
});

/**
 * Split a UTF-8 string into one or more 64-byte HID reports on a channel.
 * @param {string} message
 * @param {number} channel
 * @returns {Buffer[]}
 */
export function encode(message, channel = Channel.RPC) {
  const bytes = Buffer.from(message, "utf8");
  const reports = [];
  let offset = 0;

  do {
    const chunk = Math.min(MAX_PAYLOAD, bytes.length - offset);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = channel;
    report[2] = chunk;
    bytes.copy(report, 3, offset, offset + chunk);
    reports.push(report);
    offset += chunk;
  } while (offset < bytes.length);

  return reports;
}

/**
 * Reassembles inbound reports into complete newline-terminated lines,
 * demultiplexed by channel. Feed it raw report buffers; it emits lines.
 */
export class Reassembler {
  constructor() {
    /** @type {Record<number, string>} */
    this.buffers = { [Channel.DEBUG]: "", [Channel.RPC]: "" };
  }

  /**
   * Push one raw HID report (with or without the leading report-ID byte —
   * some kernels strip it on read, so we detect and normalise).
   * @param {Buffer} report
   * @returns {{channel: number, line: string}[]} completed lines
   */
  push(report) {
    const view = normaliseReport(report);
    const channel = view[0];
    const length = view[1];
    const payload = view.subarray(2, 2 + length).toString("utf8");

    if (this.buffers[channel] === undefined) this.buffers[channel] = "";
    this.buffers[channel] += payload;

    const out = [];
    const endsInNewline = /[\r\n]$/.test(payload);
    const parts = this.buffers[channel].split(/\r?\n/);
    if (parts.length > 1 || endsInNewline) {
      for (let i = 0; i < parts.length - 1; i++) {
        const line = parts[i].trim();
        if (line) out.push({ channel, line });
      }
      this.buffers[channel] = parts[parts.length - 1];
    }
    return out;
  }
}

/**
 * A report may arrive as 64 bytes ([reportID, channel, len, ...]) or as 63
 * bytes with the report ID already stripped by the kernel ([channel, len, ...]).
 * Return a view whose byte 0 is `channel`.
 * @param {Buffer} report
 */
function normaliseReport(report) {
  if (report.length >= 1 && report[0] === REPORT_ID) {
    return report.subarray(1);
  }
  return report;
}
