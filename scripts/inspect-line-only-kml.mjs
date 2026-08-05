const port = process.argv[2] ?? "9231";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("Desktop renderer target was not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === 1) resolve(message.result.result.value);
  });
  socket.addEventListener("error", reject, { once: true });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `({
        fileLoaded: document.body.innerText.includes("line-only-without-placemark.kml"),
        routeLoaded: document.body.innerText.includes("巡检线路"),
        featureCount: document.querySelectorAll(".feature-row").length,
        renderedVectors: document.querySelectorAll(".leaflet-overlay-pane canvas, .leaflet-interactive").length,
        hasError: Boolean(document.querySelector(".toast.error"))
      })`,
      returnByValue: true,
    },
  }));
});

socket.close();
console.log(JSON.stringify(result));
