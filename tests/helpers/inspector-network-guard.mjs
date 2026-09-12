// Test/replay harness only. Not part of the distributable or the web application.
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dgram from "node:dgram";
import http2 from "node:http2";
import { syncBuiltinESMExports } from "node:module";

const blocked = () => {
  process.stderr.write("UNEXPECTED_NETWORK_OR_DATABASE_CONNECTION\n");
  process.exit(91);
};
net.Socket.prototype.connect = blocked;
net.connect = blocked;
net.createConnection = blocked;
tls.connect = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
http2.connect = blocked;
dgram.createSocket = blocked;
globalThis.fetch = blocked;
globalThis.WebSocket = blocked;
syncBuiltinESMExports();
