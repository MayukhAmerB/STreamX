// clamd stand-in speaking the real TCP protocol (zPING, zVERSION, zINSTREAM).
// A stream containing E2E-INFECTED or the EICAR test string is "infected".
import net from "node:net";

const MARKERS = [Buffer.from("E2E-INFECTED"), Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")];

export function createClamdStub({ log = () => {} } = {}) {
  const state = { scans: 0, infected: 0 };

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let mode = "command";
    let data = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (mode === "command") {
          const end = buffer.indexOf(0);
          if (end < 0) return;
          const command = buffer.subarray(0, end).toString("ascii");
          buffer = buffer.subarray(end + 1);
          if (command === "zPING") {
            socket.end("PONG\0");
            return;
          }
          if (command === "zVERSION") {
            socket.end("ClamAV 1.4.1-e2e/27000/Thu Jan  1 00:00:00 2026\0");
            return;
          }
          if (command === "zINSTREAM") {
            mode = "stream";
            continue;
          }
          socket.end("UNKNOWN COMMAND\0");
          return;
        }
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          state.scans += 1;
          const infected = MARKERS.some((marker) => data.includes(marker));
          if (infected) state.infected += 1;
          log(`clamd stub: scanned ${data.length} bytes, infected=${infected}`);
          socket.end(infected ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buffer.length < 4 + length) return;
        data = Buffer.concat([data, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  return { server, state };
}
