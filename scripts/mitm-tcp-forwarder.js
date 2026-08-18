const net = require("net");

const listenHost = process.env.LISTEN_HOST || "0.0.0.0";
const listenPort = Number(process.env.LISTEN_PORT || 8787);
const targetHost = process.env.TARGET_HOST || "127.0.0.1";
const targetPort = Number(process.env.TARGET_PORT || 8799);

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

const server = net.createServer((client) => {
  const clientLabel = `${client.remoteAddress}:${client.remotePort}`;
  log(`client connected ${clientLabel}`);

  const target = net.createConnection({ host: targetHost, port: targetPort }, () => {
    client.pipe(target);
    target.pipe(client);
  });

  const closeBoth = () => {
    client.destroy();
    target.destroy();
  };

  client.on("error", (error) => log(`client error ${clientLabel}: ${error.message}`));
  target.on("error", (error) => log(`target error ${clientLabel}: ${error.message}`));
  client.on("close", () => log(`client closed ${clientLabel}`));
  target.on("close", closeBoth);
});

server.on("error", (error) => {
  log(`server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(listenPort, listenHost, () => {
  log(`forwarding ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
});
